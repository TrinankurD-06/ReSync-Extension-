// Usage estimates on claude.ai: counts messages the user sends, the tokens they typed, and an estimated range of
// tokens claude.ai processed (the chat so far is re-read on every turn, plus attachments, project files and hidden
// instructions; replies are counted once they finish). Messages already on the page when it loads are history:
// they are not new usage, but they do join the context that later turns re-read.
// Only numbers are stored. No message text leaves this file.
import { estimateTokens } from '@resync/shared/tokens';
import { queryAll, query, isStreaming, messageKey, selectorList, PROJECT_CAPACITY_TEXT } from '../lib/selectors.js';
import { createChatEstimator, projectFileTokens, attachmentTokens, capacityToTokens, defaultUsageModel } from '../lib/usageEstimates.js';
import { markdownOf } from './conversation.js';

/**
 * @typedef {import('../lib/usageEstimates.js').Range} Range
 * @typedef {{
 *   chatContext(chatId: string): Promise<Range | null>,
 *   saveChatContext(chatId: string, c: Range): Promise<void>,
 *   detectedProjects(): Promise<Record<string, Range>>,
 *   saveDetectedProject(project: string, percent: number, tokens: Range): Promise<void>,
 * }} UsageMemory
 */

/**
 * Attachments shown with a message: images and files inside its turn container.
 * @param {Element} el
 * @param {{ overrides?: Record<string, string[]> }} o
 */
export function countAttachments(el, o) {
  let root = null;
  for (const sel of selectorList('turnContainer', o.overrides)) {
    try {
      root = el.closest(sel);
    } catch {
      /* invalid override */
    }
    if (root) break;
  }
  root ??= el.parentElement ?? el;
  return { images: queryAll('messageImage', { ...o, root }).length, files: queryAll('messageFile', { ...o, root }).length };
}

/**
 * On a project page, read "N% of project capacity used" and remember the project's knowledge size.
 * @param {{ overrides?: Record<string, string[]>, pathname?: string, capacityTokens: number }} o
 * @returns {{ project: string, percent: number, tokens: Range } | null}
 */
export function detectProjectKnowledge(o) {
  const pathname = o.pathname ?? location.pathname;
  if (!/^\/project\/[^/]+/.test(pathname)) return null;
  const project = (query('projectTitle', o)?.textContent ?? '').trim();
  const m = PROJECT_CAPACITY_TEXT.exec(query('projectKnowledge', o)?.textContent ?? '');
  if (!project || !m) return null;
  const percent = Number(m[1]);
  return { project: project.slice(0, 120), percent, tokens: capacityToTokens(percent, o.capacityTokens) };
}

/**
 * @param {{
 *   add: (e: { project: string, messages?: number, typedTokens?: number, processed?: Range }) => Promise<unknown>,
 *   getOverrides: () => Record<string, string[]>,
 *   getModel?: () => import('../lib/usageEstimates.js').UsageModel,
 *   memory?: UsageMemory,
 *   projectName?: () => string,
 *   chatId?: () => string,
 * }} o
 */
export function createUsageTracker(o) {
  // claude.ai keeps only part of a long chat in the page and re-adds messages as you scroll, so messages are
  // remembered by turn key (or role + text when there is none), not by element.
  const seen = new Set();
  /** Replies seen while still streaming; counted once they finish. @type {Map<Element, 'u' | 'a'>} */
  const pending = new Map();
  /** Replies already counted. */
  const counted = new Set();
  const opts = () => ({ overrides: o.getOverrides() });
  const model = () => o.getModel?.() ?? defaultUsageModel();
  const project = o.projectName ?? (() => {
    const link = query('currentProjectLink', opts());
    return (link?.textContent ?? '').trim() || 'No project';
  });
  const chatId = o.chatId ?? (() => /^\/chat\/([^/?#]+)/.exec(location.pathname)?.[1] ?? '');
  /** @param {Element} el @param {'u' | 'a'} role */
  const keyOf = (el, role) => {
    const k = messageKey(el);
    return typeof k === 'string' ? k : `${role}:${(el.textContent ?? '').trim().slice(0, 500)}`;
  };
  /** User and assistant messages on the page, in page order. */
  const messages = () => {
    const all = [
      ...queryAll('userMessage', opts()).map((el) => ({ el, role: /** @type {const} */ ('u') })),
      ...queryAll('assistantMessage', opts()).map((el) => ({ el, role: /** @type {const} */ ('a') })),
    ];
    return all.sort((x, y) => (x.el.compareDocumentPosition(y.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
  };
  /** @param {Element} el */
  const streaming = (el) => Boolean(el.closest('[data-is-streaming="true"]') || el.querySelector('[data-is-streaming="true"]'));
  /** @param {Element} el @param {'u' | 'a'} role */
  const sizeOf = (el, role) => ({ tokens: estimateTokens(markdownOf(el)), ...(role === 'u' ? countAttachments(el, opts()) : {}) });

  /** The current chat's running estimate. Rebuilt by baseline(). */
  let chat = { id: '', project: 'No project', est: createChatEstimator({ model: model(), project: { low: 0, high: 0 } }) };
  let ready = Promise.resolve();

  /**
   * Mark everything currently on the page as already seen (history): it joins the chat's context, which later
   * turns re-read, but it is not counted as new usage. A saved context for this chat wins if it is larger
   * (claude.ai may not render all of a long chat).
   */
  function baseline() {
    const history = { low: 0, high: 0 };
    const m = model();
    for (const msg of messages()) {
      seen.add(keyOf(msg.el, msg.role));
      const size = sizeOf(msg.el, msg.role);
      const a = attachmentTokens(size, m);
      history.low += size.tokens + a.low;
      history.high += size.tokens + a.high;
    }
    const id = chatId();
    const proj = project();
    ready = (async () => {
      const saved = o.memory ? await o.memory.chatContext(id).catch(() => null) : null;
      const detected = o.memory ? await o.memory.detectedProjects().catch(() => ({})) : {};
      const context = saved && saved.high > history.high ? { low: saved.low, high: saved.high } : history;
      chat = { id, project: proj, est: createChatEstimator({ model: m, project: projectFileTokens(proj, { detected, model: m }), context }) };
    })();
    return ready;
  }

  const save = () => (o.memory && chat.id ? o.memory.saveChatContext(chat.id, chat.est.context).catch(() => {}) : Promise.resolve());

  /** Look for new messages and finished replies. Call on page mutations. */
  async function scan() {
    await ready;
    const kn = detectProjectKnowledge({ ...opts(), capacityTokens: model().projectCapacityTokens });
    if (kn && o.memory) await o.memory.saveDetectedProject(kn.project, kn.percent, kn.tokens).catch(() => {});
    const proj = project();
    // A new chat (/new) gets its id once the first message is sent; keep the running context for it.
    if (!chat.id && chatId()) chat.id = chatId();
    const list = messages();
    // Messages above the first one already seen were loaded from history ("Load earlier messages").
    const firstSeen = list.findIndex((m) => seen.has(keyOf(m.el, m.role)));
    for (const [i, m] of list.entries()) {
      // Text keys change while a reply streams: wait until it finishes before remembering it.
      if (m.role === 'a' && typeof messageKey(m.el) !== 'string' && streaming(m.el)) {
        pending.set(m.el, m.role);
        continue;
      }
      const k = keyOf(m.el, m.role);
      if (seen.has(k)) continue;
      seen.add(k);
      if (firstSeen >= 0 && i < firstSeen) continue;
      if (m.role === 'u') {
        const r = chat.est.user(sizeOf(m.el, 'u'));
        await o.add({ project: proj, messages: 1, typedTokens: r.typed, processed: r.processed });
        await save();
      } else pending.set(m.el, m.role);
    }
    if (pending.size && !isStreaming(opts())) {
      for (const [el, role] of pending) {
        pending.delete(el);
        if (!el.isConnected) continue;
        const k = keyOf(el, role);
        if (counted.has(k)) continue;
        counted.add(k);
        seen.add(k);
        const r = chat.est.reply(sizeOf(el, 'a'));
        await o.add({ project: proj, processed: r.processed });
        await save();
      }
    }
  }

  return { baseline, scan, get ready() { return ready; } };
}
