// Reading, filling and sending the claude.ai message box. The composer is a rich-text editor
// (ProseMirror contenteditable today), so text must go in through events the editor understands;
// writing innerHTML directly would leave the editor's internal state out of sync.
import { query, sendButtonFor } from './selectors.js';

/** @param {Element} el */
const isTextField = (el) => el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement;

/** Current text in the composer. @param {Element} el */
export function readText(el) {
  return isTextField(el) ? /** @type {HTMLTextAreaElement} */ (el).value : (/** @type {HTMLElement} */ (el).innerText ?? el.textContent ?? '');
}

/** @param {HTMLElement} el */
function selectAll(el) {
  const range = document.createRange();
  range.selectNodeContents(el);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
}

/** @param {HTMLElement} el */
function caretToEnd(el) {
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
}

const norm = (s) => s.replace(/\s+/g, ' ').trim();

/**
 * Put text into the composer.
 * @param {Element} el composer element
 * @param {string} text
 * @param {{ replace?: boolean }} [o] replace existing text (default: append at the end)
 * @returns {'textarea' | 'paste' | 'execCommand' | 'dom'} the method that worked
 */
export function insertText(el, text, o = {}) {
  const html = /** @type {HTMLElement} */ (el);
  html.focus();
  if (isTextField(el)) {
    const field = /** @type {HTMLTextAreaElement} */ (el);
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    const value = o.replace ? text : field.value + text;
    // Native setter so frameworks (React etc.) notice the change.
    if (setter) setter.call(field, value);
    else field.value = value;
    field.dispatchEvent(new Event('input', { bubbles: true }));
    return 'textarea';
  }

  if (o.replace) selectAll(html);
  else caretToEnd(html);
  const before = norm(readText(el));
  const landed = () => {
    const now = norm(readText(el));
    return now !== before && now.includes(norm(text).slice(0, 40));
  };

  // 1) Paste: ProseMirror handles multi-line text from the clipboard natively.
  try {
    if (typeof DataTransfer !== 'undefined' && typeof ClipboardEvent !== 'undefined') {
      const dt = new DataTransfer();
      dt.setData('text/plain', text);
      html.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      if (landed()) return 'paste';
    }
  } catch {
    /* try the next method */
  }
  // 2) execCommand insertText: deprecated but still supported for editable content.
  try {
    if (typeof document.execCommand === 'function' && document.execCommand('insertText', false, text) && landed()) return 'execCommand';
  } catch {
    /* try the next method */
  }
  // 3) Last resort: write paragraphs and fire an input event.
  if (o.replace) html.textContent = '';
  for (const line of text.split('\n')) {
    const p = document.createElement('p');
    p.textContent = line;
    html.appendChild(p);
  }
  html.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
  return 'dom';
}

/**
 * Remove a trailing trigger (e.g. ";;") from the composer text.
 * @param {Element} el
 * @param {string} trigger
 */
export function removeTrailing(el, trigger) {
  const text = readText(el).replace(/\n+$/, '');
  if (!text.endsWith(trigger)) return false;
  insertText(el, text.slice(0, -trigger.length), { replace: true });
  return true;
}

/**
 * Remove the last trigger (e.g. ";;") and anything typed after it on the same line, such as a search
 * query that landed in the composer. In a rich-text editor the tail is selected and deleted through the
 * editor (so its state stays in sync); otherwise the whole text is rewritten.
 * @param {Element} el
 * @param {string} trigger
 * @returns {boolean} whether a trigger was found
 */
export function removeTrigger(el, trigger) {
  const text = readText(el).replace(/\s+$/, '');
  const at = text.lastIndexOf(trigger);
  if (at < 0) return false;
  const tail = text.slice(at);
  if (/\n/.test(tail) || tail.length > 200) return false;
  const kept = text.slice(0, at);
  if (!isTextField(el)) {
    const html = /** @type {HTMLElement} */ (el);
    html.focus();
    caretToEnd(html);
    const sel = window.getSelection();
    try {
      if (sel && typeof sel.modify === 'function') {
        for (let i = 0; i < tail.length; i++) sel.modify('extend', 'backward', 'character');
        if (sel.toString() === tail && document.execCommand('delete') && readText(el).replace(/\s+$/, '') === kept.replace(/\s+$/, '')) return true;
      }
    } catch {
      /* fall back to rewriting */
    }
  }
  insertText(el, kept, { replace: true });
  return true;
}

/**
 * Send the current message: click the send button, or press Enter in the composer.
 * @param {{ root?: ParentNode, overrides?: Record<string, string[]> }} [o]
 * @returns {boolean} whether a send was attempted
 */
export function submit(o = {}) {
  const btn = /** @type {HTMLButtonElement | null} */ (query('sendButton', o));
  if (btn && !btn.disabled) {
    btn.click();
    return true;
  }
  const el = query('composer', o);
  if (!el) return false;
  const opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
  el.dispatchEvent(new KeyboardEvent('keydown', opts));
  el.dispatchEvent(new KeyboardEvent('keyup', opts));
  return true;
}

/** Is the send button there and enabled? @param {HTMLButtonElement | null} btn */
const enabled = (btn) => Boolean(btn && !btn.disabled && btn.getAttribute('aria-disabled') !== 'true');

/**
 * Insert text and check that the editor registered it: the text is in the box, and the send button (when there is
 * one) is enabled. claude.ai keeps Send disabled until its editor state has text, so a disabled button after an
 * insert means the editor didn't take it (e.g. only the DOM changed).
 * @param {Element} el composer element
 * @param {string} text
 * @param {{ replace?: boolean, overrides?: Record<string, string[] | string>, tries?: number, wait?: (ms: number) => Promise<void> }} [o]
 * @returns {Promise<{ ok: boolean, method: string, present: boolean, sendReady: boolean }>}
 */
export async function insertAndVerify(el, text, o = {}) {
  const method = insertText(el, text, { replace: o.replace });
  const want = norm(text).slice(0, 60);
  const wait = o.wait ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  let present = false;
  let sendReady = false;
  let hasButton = false;
  // The editor and the button update asynchronously (React re-render): give them up to ~1 s.
  for (let i = 0; i < (o.tries ?? 10); i++) {
    present = norm(readText(el)).includes(want);
    const btn = sendButtonFor(el, { overrides: o.overrides });
    hasButton = Boolean(btn);
    sendReady = enabled(btn);
    if (present && (sendReady || !hasButton)) break;
    await wait(100);
  }
  return { ok: present && (sendReady || !hasButton), method, present, sendReady };
}

/**
 * Copy text to the clipboard (fallback when the message box can't be found or filled). Uses the async clipboard
 * API, then a hidden textarea + execCommand('copy'). Returns whether it worked; browsers may refuse without a
 * recent click.
 * @param {string} text
 */
export async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    /* try the old way */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    const ok = typeof document.execCommand === 'function' && document.execCommand('copy');
    ta.remove();
    return Boolean(ok);
  } catch {
    return false;
  }
}
