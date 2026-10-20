// Putting text into the claude.ai message box on any page type (chat, new chat, project home), with a check that
// the editor took it, and a visible fallback when it can't be found: "Couldn't find the message box. Click into it
// and press Retry", with the text copied to the clipboard so it is never lost.
import { waitForComposer, findComposer, isVisible } from '../lib/selectors.js';
import { insertAndVerify, copyToClipboard, submit } from '../lib/composer.js';

export const FALLBACK_ID = 'resync-insert-fallback';
export const NOT_FOUND_MESSAGE = "Couldn't find the message box. Click into it and press Retry";

/** The editable element the user last clicked into: Retry uses it when detection still fails. */
let lastEditable = /** @type {HTMLElement | null} */ (null);

/** Remember where the user clicks into an editor (call once per page). @param {Document} [doc] */
export function trackFocus(doc = document) {
  doc.addEventListener('focusin', (e) => {
    const t = /** @type {HTMLElement} */ (e.target);
    if (!t || t.closest?.(`#${FALLBACK_ID}`)) return;
    if (t.isContentEditable || t instanceof HTMLTextAreaElement) lastEditable = t;
  }, true);
}

/**
 * @typedef {{ replace?: boolean, autoSend?: boolean, overrides?: Record<string, string[] | string>, timeoutMs?: number, wait?: (ms: number) => Promise<void> }} DeliverOptions
 * @typedef {{ ok: true, method: string, page: string, sendReady: boolean, sent: boolean } | { ok: false, error: string, copied: boolean }} DeliverResult
 */

/**
 * Wait for the composer, insert, verify; optionally press Send. On failure, show the fallback and copy the text.
 * @param {string} text
 * @param {DeliverOptions} [o]
 * @returns {Promise<DeliverResult>}
 */
export async function deliverText(text, o = {}) {
  const found = await waitForComposer({ overrides: o.overrides, timeoutMs: o.timeoutMs ?? 10_000, pathname: () => location.pathname });
  if (found) {
    const r = await insertAndVerify(found.el, text, { replace: o.replace, overrides: o.overrides, wait: o.wait });
    if (r.ok) {
      const sent = Boolean(o.autoSend && r.sendReady && submit({ overrides: o.overrides }));
      return { ok: true, method: r.method, page: found.page, sendReady: r.sendReady, sent };
    }
  }
  const copied = await copyToClipboard(text);
  showFallback(text, o, copied);
  return { ok: false, error: `${NOT_FOUND_MESSAGE}.${copied ? ' The text is also on your clipboard.' : ''}`, copied };
}

/**
 * The on-page fallback: the message, Retry (uses the box you clicked into, else detection again), Copy, Dismiss.
 * @param {string} text
 * @param {DeliverOptions} o
 * @param {boolean} copied
 */
export function showFallback(text, o, copied) {
  document.getElementById(FALLBACK_ID)?.remove();
  const box = document.createElement('div');
  box.id = FALLBACK_ID;
  box.setAttribute('role', 'alert');
  box.style.cssText = 'position:fixed;z-index:2147483647;top:12px;right:12px;max-width:360px;padding:10px 12px;border-radius:10px;background:#7c2d12;color:#fff;font:13px/1.4 system-ui,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.3)';
  const msg = document.createElement('div');
  const say = (t) => (msg.textContent = t);
  say(`ReSync: ${NOT_FOUND_MESSAGE}.${copied ? ' Your text is also on the clipboard (Ctrl+V / Cmd+V).' : ''}`);
  const btn = (label, fn) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.style.cssText = 'margin:8px 6px 0 0;background:transparent;color:#fff;border:1px solid #fff;border-radius:6px;padding:2px 8px;cursor:pointer;font:inherit';
    b.addEventListener('click', fn);
    return b;
  };
  const retry = btn('Retry', async () => {
    const target = lastEditable?.isConnected && isVisible(lastEditable) ? lastEditable : findComposer({ overrides: o.overrides })?.el;
    if (!target) return say(`ReSync: still no message box. ${NOT_FOUND_MESSAGE}.`);
    const r = await insertAndVerify(target, text, { replace: o.replace, overrides: o.overrides, wait: o.wait });
    if (r.ok) box.remove();
    else say("ReSync: the text didn't register in the message box. Paste it yourself (Copy, then Ctrl+V / Cmd+V).");
  });
  const copy = btn('Copy text', async () => say((await copyToClipboard(text)) ? 'ReSync: copied. Paste it into the message box.' : "ReSync: the browser didn't allow copying."));
  const close = btn('Dismiss', () => box.remove());
  box.append(msg, retry, copy, close);
  document.body.appendChild(box);
  return box;
}
