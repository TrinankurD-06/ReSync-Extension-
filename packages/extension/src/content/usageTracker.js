// Counts messages the user sends on claude.ai and estimates tokens for them and for finished replies.
// Messages already on the page when it loads are history and are not counted.
import { estimateTokens } from '@resync/shared/tokens';
import { queryAll, query, isStreaming, messageKey } from '../lib/selectors.js';
import { markdownOf } from './conversation.js';

/**
 * @param {{
 *   add: (e: { project: string, messages?: number, tokens?: number }) => Promise<unknown>,
 *   getOverrides: () => Record<string, string[]>,
 *   projectName?: () => string,
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
  const project = o.projectName ?? (() => {
    const link = query('currentProjectLink', opts());
    return (link?.textContent ?? '').trim() || 'No project';
  });
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

  /** Mark everything currently on the page as already seen (history). */
  function baseline() {
    for (const m of messages()) seen.add(keyOf(m.el, m.role));
  }

  /** Look for new messages and finished replies. Call on page mutations. */
  async function scan() {
    const proj = project();
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
      if (m.role === 'u') await o.add({ project: proj, messages: 1, tokens: estimateTokens(markdownOf(m.el)) });
      else pending.set(m.el, m.role);
    }
    if (pending.size && !isStreaming(opts())) {
      for (const [el, role] of pending) {
        pending.delete(el);
        if (!el.isConnected) continue;
        const k = keyOf(el, role);
        if (counted.has(k)) continue;
        counted.add(k);
        seen.add(k);
        await o.add({ project: proj, tokens: estimateTokens(markdownOf(el)) });
      }
    }
  }

  return { baseline, scan };
}
