// EVERY claude.ai selector lives here (spec section 5). claude.ai changes without notice, so:
//  - each element has an ordered list of fallbacks (most specific first, most generic last);
//  - users can override any entry from Settings without a new release;
//  - healthCheck() reports what is missing so the UI can show a clear banner instead of failing silently.
// These selectors are NOT verified against the live site from the build machine (it needs a login); see
// docs/VERIFIED.md. Fix them here when the site changes.

/** @type {Record<string, string[]>} */
export const SELECTORS = {
  // The message box. ProseMirror contenteditable today; textarea as a generic fallback.
  composer: [
    '[data-testid="chat-input"]',
    'div[contenteditable="true"].ProseMirror',
    'div[contenteditable="true"][role="textbox"]',
    'fieldset div[contenteditable="true"]',
    'textarea[placeholder]',
  ],
  sendButton: ['button[aria-label="Send message"]', 'button[aria-label*="Send" i]', 'fieldset button[type="submit"]'],
  // Present only while a reply is streaming.
  stopButton: ['button[aria-label="Stop response"]', 'button[aria-label*="Stop" i]'],
  streamingIndicator: ['[data-is-streaming="true"]'],
  userMessage: ['[data-testid="user-message"]', '[data-message-author-role="user"]'],
  assistantMessage: ['.font-claude-response', '.font-claude-message', '[data-message-author-role="assistant"]', '[data-is-streaming]'],
  sidebarProjectLink: ['nav a[href^="/project/"]', 'a[href^="/project/"]'],
  sidebarChatLink: ['nav a[href^="/chat/"]', 'a[href^="/chat/"]'],
  // The project the open chat belongs to (breadcrumb/header link), for per-project usage estimates.
  currentProjectLink: ['header a[href^="/project/"]', 'main a[href^="/project/"]'],
  // Error or limit notices shown in the conversation.
  alert: ['[role="alert"]', '[data-testid*="error" i]'],
};

/** Elements that must exist on a chat page for the composer features to work. */
export const REQUIRED_ON_CHAT = ['composer'];
/** Elements expected in the app shell (sidebar) on any signed-in page. */
export const REQUIRED_IN_APP = ['sidebarChatLink'];

/** Text that means the user hit a usage limit (used to stop chains). */
export const LIMIT_TEXT = /you(?:'|’)ve (?:hit|reached) (?:your|the) [\w ]*limit|usage limit|message limit|out of (?:free )?messages|limit reached|resets? (?:at|in) /i;

/**
 * Selector list for a name, with user overrides (Settings) first.
 * @param {string} name
 * @param {Record<string, string[] | string>} [overrides]
 */
export function selectorList(name, overrides = {}) {
  const o = overrides[name];
  const extra = Array.isArray(o) ? o : typeof o === 'string' && o.trim() ? [o] : [];
  return [...extra, ...(SELECTORS[name] ?? [])];
}

/**
 * First element matching any selector for `name` (invalid selectors are skipped).
 * @param {string} name
 * @param {{ root?: ParentNode, overrides?: Record<string, string[] | string> }} [o]
 * @returns {Element | null}
 */
export function query(name, o = {}) {
  const root = o.root ?? document;
  for (const sel of selectorList(name, o.overrides)) {
    try {
      const el = root.querySelector(sel);
      if (el) return el;
    } catch {
      /* invalid override selector: try the next */
    }
  }
  return null;
}

/**
 * All matching elements for the first selector that matches anything.
 * @param {string} name
 * @param {{ root?: ParentNode, overrides?: Record<string, string[] | string> }} [o]
 * @returns {Element[]}
 */
export function queryAll(name, o = {}) {
  const root = o.root ?? document;
  for (const sel of selectorList(name, o.overrides)) {
    try {
      const els = root.querySelectorAll(sel);
      if (els.length) return [...els];
    } catch {
      /* skip */
    }
  }
  return [];
}

/** Is this a conversation page (/chat/<id> or /new)? @param {string} pathname */
export function isChatPage(pathname) {
  return /^\/(chat\/|new\b|project\/[^/]+\/?$)/.test(pathname);
}

/**
 * Check the selectors that matter on the current page.
 * @param {{ root?: ParentNode, pathname?: string, overrides?: Record<string, string[] | string> }} [o]
 * @returns {{ ok: boolean, missing: string[], page: 'chat' | 'other' }}
 */
export function healthCheck(o = {}) {
  const pathname = o.pathname ?? (typeof location !== 'undefined' ? location.pathname : '/');
  const page = isChatPage(pathname) ? 'chat' : 'other';
  const required = page === 'chat' ? [...REQUIRED_IN_APP, ...REQUIRED_ON_CHAT] : REQUIRED_IN_APP;
  const missing = required.filter((name) => !query(name, o));
  return { ok: missing.length === 0, missing, page };
}

/**
 * Is a reply streaming right now?
 * @param {{ root?: ParentNode, overrides?: Record<string, string[] | string> }} [o]
 */
export function isStreaming(o = {}) {
  return Boolean(query('stopButton', o) || query('streamingIndicator', o));
}

/**
 * Text of the visible limit/error notice, if any.
 * @param {{ root?: ParentNode, overrides?: Record<string, string[] | string> }} [o]
 * @returns {{ kind: 'limit' | 'error', text: string } | null}
 */
export function findAlert(o = {}) {
  for (const el of queryAll('alert', o)) {
    const text = (el.textContent ?? '').trim();
    if (!text) continue;
    return { kind: LIMIT_TEXT.test(text) ? 'limit' : 'error', text: text.slice(0, 300) };
  }
  // Limit notices are not always role="alert"; check the last assistant message too.
  const msgs = queryAll('assistantMessage', o);
  const lastText = (msgs.at(-1)?.textContent ?? '').trim();
  if (lastText && lastText.length < 400 && LIMIT_TEXT.test(lastText)) return { kind: 'limit', text: lastText.slice(0, 300) };
  return null;
}
