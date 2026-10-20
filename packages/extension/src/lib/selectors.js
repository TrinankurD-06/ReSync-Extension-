// EVERY claude.ai selector lives here (spec section 5). claude.ai changes without notice, so:
//  - each element has an ordered list of fallbacks (most specific first, most generic last);
//  - users can override any entry from Settings without a new release;
//  - healthCheck() reports what is missing so the UI can show a clear banner instead of failing silently.
// These selectors are NOT verified against the live site from the build machine (it needs a login); see
// docs/VERIFIED.md. Fix them here when the site changes.

/** @type {Record<string, string[]>} */
export const SELECTORS = {
  // The message box on any page. Detection goes through findComposer(), which uses the per-page lists
  // (COMPOSER_BY_PAGE); this generic list is the fallback for other callers. Overrides of "composer" go first.
  composer: [
    '[data-testid="chat-input"]',
    'div[contenteditable="true"][role="textbox"]',
    'div[contenteditable="true"].ProseMirror',
    'fieldset div[contenteditable="true"]',
    'textarea[placeholder]',
  ],
  sendButton: ['button[aria-label="Send message"]', 'button[aria-label*="Send" i]', 'fieldset button[type="submit"]'],
  // Present only while a reply is streaming.
  stopButton: ['button[aria-label="Stop response"]', 'button[aria-label*="Stop" i]'],
  streamingIndicator: ['[data-is-streaming="true"]'],
  userMessage: ['[data-testid="user-message"]', '[data-message-author-role="user"]'],
  assistantMessage: ['[data-testid="assistant-message"]', '.font-claude-response', '.font-claude-message', '[data-message-author-role="assistant"]', '[data-is-streaming]'],
  sidebarProjectLink: ['nav a[href^="/project/"]', 'a[href^="/project/"]'],
  sidebarChatLink: ['nav a[href^="/chat/"]', 'a[href^="/chat/"]'],
  // The project the open chat belongs to (breadcrumb/header link), for per-project usage estimates.
  currentProjectLink: ['header a[href^="/project/"]', 'main a[href^="/project/"]'],
  // Error or limit notices shown in the conversation.
  alert: ['[role="alert"]', '[data-testid*="error" i]'],
  // Usage estimates. The wrapper around one turn (a message plus its attachments).
  turnContainer: ['[data-test-render-count]', '[data-turn-key]'],
  // Attachments shown with a user message (searched inside its turn container).
  messageImage: ['[data-testid="file-thumbnail"] img', '[data-testid*="image" i] img', 'img[alt*="image" i]'],
  messageFile: ['[data-testid="file-thumbnail"]:not(:has(img))', '[data-testid*="attachment" i]', '[data-testid*="file" i]:not(:has(img))'],
  // Project page: its name and the "N% of project capacity used" note in the knowledge panel.
  projectTitle: ['main h1', 'h1'],
  projectKnowledge: ['[data-testid*="knowledge" i]', 'main'],
};

/** "12% of project capacity used" on a claude.ai project page. */
export const PROJECT_CAPACITY_TEXT = /(\d+(?:\.\d+)?)\s*%\s*of\s+(?:the\s+)?project\s+(?:knowledge\s+)?capacity/i;

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

/**
 * A stable identity for a message element. claude.ai renders long chats in a virtual list, so the same
 * message can be removed and re-added as a new element; its turn key survives that, the element does not.
 * @param {Element} el
 * @returns {string | Element}
 */
export function messageKey(el) {
  const keyed = el.closest?.('[data-turn-key]') ?? el.querySelector?.('[data-turn-key]');
  return keyed?.getAttribute('data-turn-key') || el;
}

/** Is this a page with a composer (/chat/<id>, /new, or a project home page)? @param {string} pathname */
export function isChatPage(pathname) {
  return pageType(pathname) !== 'other';
}

// ---- The message box (composer), per page type ----
// claude.ai has three kinds of page with a composer, built differently (fixtures of each are in
// test/fixtures/claude-pages/; recapture them when the site changes and the composer tests show which entry broke):
//  - chat:          /chat/<id>, in or out of a project. One composer at the bottom of the thread.
//  - new-chat:      /new. The composer is centred under a greeting; no thread yet.
//  - project-home:  /project/<id>. A "How can I help you today?" composer card at the top of the main column, next
//                   to the project's Instructions / Memory / Context panels (which can hold editors of their own),
//                   above the project's chat list.
// Each list prefers stable semantic attributes (role, aria-label, placeholder) over generated class names.

/** @typedef {'chat' | 'new-chat' | 'project-home' | 'other'} PageType */

/** The kind of claude.ai page, from the URL alone. @param {string} pathname @returns {PageType} */
export function pageType(pathname) {
  if (/^\/project\/[^/]+\/?$/.test(pathname)) return 'project-home';
  if (/^\/new\/?$/.test(pathname)) return 'new-chat';
  if (/^\/chat\/[^/]+/.test(pathname)) return 'chat';
  return 'other';
}

const COMPOSER_SEMANTIC = [
  '[data-testid="chat-input"]',
  'div[contenteditable="true"][role="textbox"]',
  'div[contenteditable="true"][aria-label*="prompt" i]',
  'div[contenteditable="true"][aria-label*="message" i]',
  'div[contenteditable="true"][data-placeholder]',
  'textarea[placeholder]',
  'div[contenteditable="true"].ProseMirror',
  'div[contenteditable="true"]',
];

/** Ordered fallbacks per page type (most specific first). @type {Record<PageType, string[]>} */
export const COMPOSER_BY_PAGE = {
  chat: ['fieldset [data-testid="chat-input"]', ...COMPOSER_SEMANTIC],
  'new-chat': COMPOSER_SEMANTIC,
  'project-home': [
    'main [data-testid="chat-input"]',
    'main div[contenteditable="true"][role="textbox"]',
    'main div[contenteditable="true"][data-placeholder*="help" i]',
    'main div[contenteditable="true"][aria-label*="prompt" i]',
    ...COMPOSER_SEMANTIC,
  ],
  other: COMPOSER_SEMANTIC,
};

/**
 * Containers that never hold the message box: navigation, dialogs, side panels. On a project home page the
 * Instructions, Memory and Context panels are excluded too (by their label or heading), since they have editors.
 */
const NOT_COMPOSER = 'nav, aside, [role="dialog"], [role="complementary"], [data-resync-ignore]';
const PROJECT_PANEL_LABEL = /^(?:project\s+)?(?:instructions|memory|context|knowledge|files)\b/i;

/** Rendered and not hidden? @param {Element} el */
export function isVisible(el) {
  if (el.closest('[hidden], [aria-hidden="true"], [inert]')) return false;
  const h = /** @type {HTMLElement} */ (el);
  if (typeof h.checkVisibility === 'function') return h.checkVisibility({ checkVisibilityCSS: true, visibilityProperty: true });
  for (let n = h; n; n = n.parentElement) {
    const cs = getComputedStyle(n);
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
  }
  return true;
}

/** Inside a project panel (Instructions, Memory, Context)? Judged by the panel's label or heading. @param {Element} el */
function inProjectPanel(el) {
  for (let n = el.parentElement; n && n.tagName !== 'MAIN' && n.tagName !== 'BODY'; n = n.parentElement) {
    const heading = n.querySelector(':scope > h2, :scope > h3, :scope > header h2, :scope > header h3, :scope > div > h2, :scope > div > h3');
    const label = n.getAttribute('aria-label') ?? heading?.textContent ?? '';
    if (PROJECT_PANEL_LABEL.test(label.trim())) return true;
  }
  return false;
}

/** @param {Element} el */
const editable = (el) => (el instanceof HTMLTextAreaElement ? !el.disabled && !el.readOnly : el.getAttribute('contenteditable') !== 'false');

/**
 * Find the message box on the current page. Tries the page type's selectors in order (user overrides of
 * "composer" first); the first selector with a usable match wins, and among its matches the one inside the main
 * content area. Usable = editable, visible, and not in navigation, a dialog or a project panel.
 * @param {{ root?: ParentNode, pathname?: string, overrides?: Record<string, string[] | string> }} [o]
 * @returns {{ el: HTMLElement, page: PageType, selector: string } | null}
 */
export function findComposer(o = {}) {
  const root = o.root ?? document;
  const page = pageType(o.pathname ?? (typeof location !== 'undefined' ? location.pathname : '/'));
  const all = selectorList('composer', o.overrides);
  const extra = all.slice(0, all.length - SELECTORS.composer.length);
  for (const selector of [...extra, ...COMPOSER_BY_PAGE[page]]) {
    let els;
    try {
      els = [...root.querySelectorAll(selector)];
    } catch {
      continue; // invalid override
    }
    const usable = els.filter((el) => editable(el) && isVisible(el) && !el.closest(NOT_COMPOSER) && !(page === 'project-home' && inProjectPanel(el)));
    if (!usable.length) continue;
    const best = usable.find((el) => el.closest('main, [role="main"]')) ?? usable[0];
    return { el: /** @type {HTMLElement} */ (best), page, selector };
  }
  return null;
}

/**
 * The send button that belongs to a composer (in the same form or fieldset), else any send button on the page.
 * @param {Element} composerEl
 * @param {{ overrides?: Record<string, string[] | string> }} [o]
 * @returns {HTMLButtonElement | null}
 */
export function sendButtonFor(composerEl, o = {}) {
  const scope = composerEl.closest('fieldset, form');
  return /** @type {HTMLButtonElement | null} */ ((scope && query('sendButton', { ...o, root: scope })) ?? query('sendButton', o));
}

/**
 * Wait for the message box to mount (claude.ai renders it after navigation, sometimes seconds later): check now,
 * then on every DOM change (and every 500 ms, for changes that are not mutations), until found or the timeout.
 * @param {{ root?: ParentNode, pathname?: () => string, overrides?: Record<string, string[] | string>, timeoutMs?: number, signal?: AbortSignal }} [o]
 * @returns {Promise<{ el: HTMLElement, page: PageType, selector: string } | null>}
 */
export function waitForComposer(o = {}) {
  const find = () => findComposer({ root: o.root, overrides: o.overrides, pathname: o.pathname?.() });
  const now = find();
  if (now) return Promise.resolve(now);
  return new Promise((resolve) => {
    let done = false;
    const check = () => {
      const hit = find();
      if (hit) finish(hit);
    };
    const obs = new MutationObserver(check);
    const poll = setInterval(check, 500);
    const timer = setTimeout(() => finish(null), o.timeoutMs ?? 10_000);
    function finish(v) {
      if (done) return;
      done = true;
      obs.disconnect();
      clearInterval(poll);
      clearTimeout(timer);
      resolve(v);
    }
    obs.observe(/** @type {Node} */ (o.root ?? document.body ?? document), { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'style', 'class', 'contenteditable', 'aria-hidden'] });
    o.signal?.addEventListener('abort', () => finish(null));
  });
}

/** Event the main-world nav hook (public/nav-hook.js) fires on document after history.pushState / replaceState. */
export const NAVIGATE_EVENT = 'resync:navigate';

/**
 * Call cb when the URL changes inside the single-page app. A content script's `history` is not the page's (isolated
 * world), so pushState/replaceState are seen through the main-world nav hook's event; back/forward through
 * popstate; and, as a fallback, by comparing the URL on DOM changes. Returns a function that stops watching.
 * @param {(href: string) => void} cb
 * @param {{ win?: Window }} [o]
 */
export function watchUrl(cb, o = {}) {
  const win = o.win ?? window;
  let last = win.location.href;
  const check = () => {
    if (win.location.href === last) return;
    last = win.location.href;
    cb(last);
  };
  win.addEventListener('popstate', check);
  win.document.addEventListener(NAVIGATE_EVENT, check);
  const obs = new MutationObserver(check);
  obs.observe(win.document.body ?? win.document, { childList: true, subtree: true });
  return () => {
    win.removeEventListener('popstate', check);
    win.document.removeEventListener(NAVIGATE_EVENT, check);
    obs.disconnect();
  };
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
  const missing = required.filter((name) => (name === 'composer' ? !findComposer({ ...o, pathname }) : !query(name, o)));
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
