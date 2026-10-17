// Conversation-level features on the page: read the chat (for API mode), run an AI feature in-chat
// (send the prompt in the user's own chat and capture the reply), and the pending insert used by
// "New chat with passport".
import { queryAll } from '../lib/selectors.js';
import { createChainRunner } from '../lib/chainRunner.js';
import { inChatPrompt } from '@resync/shared/templates';

export const PENDING_KEY = 'resync.pendingInsert';
const PENDING_MAX_AGE_MS = 2 * 60_000;

const BLOCK = new Set(['P', 'DIV', 'SECTION', 'ARTICLE', 'BLOCKQUOTE', 'TABLE', 'TR', 'UL', 'OL', 'HR']);

/**
 * Turn a rendered reply back into Markdown-ish text: headings become "## ...", list items "- " / "1. ",
 * code blocks stay verbatim, blocks get line breaks. Claude's replies are rendered HTML, and the shared
 * parsers (passport sections, tree JSON) expect Markdown.
 * @param {Node} node
 */
export function markdownOf(node) {
  const out = [];
  const walk = (n, listCtx) => {
    if (n.nodeType === Node.TEXT_NODE) {
      out.push(n.textContent);
      return;
    }
    if (n.nodeType !== Node.ELEMENT_NODE) return;
    const el = /** @type {HTMLElement} */ (n);
    const tag = el.tagName;
    if (tag === 'BUTTON' || tag === 'SVG' || el.getAttribute('aria-hidden') === 'true') return;
    if (tag === 'PRE') {
      // claude.ai puts a language label and a copy button in the code block: take only the <code> text.
      const code = el.querySelector('code');
      const lang = code?.className.match(/language-(\w+)/)?.[1] ?? '';
      out.push(`\n\`\`\`${lang}\n${(code ?? el).textContent.replace(/\n$/, '')}\n\`\`\`\n`);
      return;
    }
    if (tag === 'BR') return void out.push('\n');
    const h = /^H([1-6])$/.exec(tag);
    if (h) {
      out.push(`\n${'#'.repeat(Math.max(2, Number(h[1])))} ${el.textContent.trim()}\n`);
      return;
    }
    if (tag === 'LI') {
      const idx = listCtx?.ordered ? `${++listCtx.n}. ` : '- ';
      out.push(`\n${idx}`);
      for (const c of el.childNodes) walk(c, listCtx);
      return;
    }
    const ctx = tag === 'OL' ? { ordered: true, n: 0 } : tag === 'UL' ? { ordered: false, n: 0 } : listCtx;
    if (BLOCK.has(tag)) out.push('\n');
    for (const c of el.childNodes) walk(c, ctx);
    if (BLOCK.has(tag)) out.push('\n');
  };
  walk(node, null);
  return out.join('').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * User and assistant messages in page order.
 * @param {{ root?: ParentNode, overrides?: Record<string, string[]> }} [o]
 * @returns {{ role: 'user' | 'assistant', content: string }[]}
 */
export function readConversation(o = {}) {
  const tagged = [
    ...queryAll('userMessage', o).map((el) => ({ el, role: /** @type {const} */ ('user') })),
    ...queryAll('assistantMessage', o).map((el) => ({ el, role: /** @type {const} */ ('assistant') })),
  ];
  // Drop elements nested inside another matched element (some fallbacks match wrappers and inner nodes).
  const top = tagged.filter((t) => !tagged.some((u) => u !== t && u.el.contains(t.el)));
  top.sort((a, b) => (a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
  return top
    .map((t) => ({ role: t.role, content: markdownOf(t.el) }))
    .filter((m) => m.content);
}

/**
 * Run passport/tree/summary IN-CHAT: send the instructions in the current chat (as a one-step chain, so it
 * waits for the reply to finish), then return the reply text.
 * @param {'passport' | 'tree' | 'summary'} feature
 * @param {{ page: import('../lib/chainRunner.js').ChainPage, wait?: (ms: number) => Promise<void>, overrides?: Record<string, string[]>, onState?: (s: any) => void, options?: object }} o
 */
export async function runInChat(feature, o) {
  const runner = createChainRunner({
    page: o.page,
    steps: [{ text: inChatPrompt(feature), waitFor: 'response', delaySeconds: 0 }],
    wait: o.wait,
    onState: o.onState,
    options: o.options,
  });
  const final = await runner.start();
  if (final.status !== 'done') return { ok: false, error: final.reason ?? `The request ${final.status}.` };
  const msgs = readConversation({ overrides: o.overrides });
  const last = [...msgs].reverse().find((m) => m.role === 'assistant');
  if (!last) return { ok: false, error: "ReSync couldn't read Claude's reply from the page." };
  return { ok: true, text: last.content };
}

/**
 * Save text to insert into the next claude.ai composer that appears (used after opening a new chat).
 * @param {string} text
 * @param {{ set(o: Record<string, any>): Promise<void> }} [area]
 */
export function setPendingInsert(text, area = chrome.storage.local) {
  return area.set({ [PENDING_KEY]: { text, at: Date.now() } });
}

/**
 * If a fresh pending insert exists, take it (once).
 * @param {{ get(k: string): Promise<Record<string, any>>, remove(k: string): Promise<void> }} [area]
 * @returns {Promise<string | null>}
 */
export async function takePendingInsert(area = chrome.storage.local) {
  const p = (await area.get(PENDING_KEY))[PENDING_KEY];
  if (!p) return null;
  await area.remove(PENDING_KEY);
  return Date.now() - p.at <= PENDING_MAX_AGE_MS ? p.text : null;
}
