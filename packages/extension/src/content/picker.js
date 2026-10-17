// The ";;" quick picker: type ";;" in the claude.ai message box to search saved prompts and insert one,
// filling {{variables}} in a small form. Plain DOM in a shadow root (no page styles leak in or out).
import { renderVariables, promptText } from '@resync/shared/prompts';
import { searchPrompts } from '../lib/library.js';
import { insertText, readText, removeTrigger } from '../lib/composer.js';

export const TRIGGER = ';;';

const CSS = `
:host { all: initial; }
.box { position: fixed; z-index: 2147483646; width: 360px; max-height: 340px; overflow: auto; background: #fff; color: #1c1c22;
  border: 1px solid #d0d0d8; border-radius: 10px; box-shadow: 0 8px 28px rgba(0,0,0,.18); font: 13px/1.4 system-ui, sans-serif; padding: 8px; }
@media (prefers-color-scheme: dark) { .box { background: #212128; color: #ececf1; border-color: #3a3a44; } }
input[aria-invalid="true"] { border-color: #dc2626; }
input { width: 100%; box-sizing: border-box; padding: 6px 8px; border: 1px solid #c8c8d2; border-radius: 6px; font: inherit; background: transparent; color: inherit; }
ul { list-style: none; margin: 6px 0 0; padding: 0; }
li { padding: 6px 8px; border-radius: 6px; cursor: pointer; }
li[aria-selected="true"] { background: rgba(79,70,229,.15); }
.meta { opacity: .7; font-size: 11px; }
label { display: block; margin: 6px 0 2px; font-size: 12px; opacity: .8; }
button { margin-top: 8px; padding: 6px 10px; border-radius: 6px; border: 0; background: #4f46e5; color: #fff; font: inherit; cursor: pointer; }
.hint { font-size: 11px; opacity: .7; margin-top: 6px; }
`;

/**
 * @param {{
 *   getPrompts: () => Promise<import('@resync/shared/prompts').Prompt[]>,
 *   getComposer: () => Element | null,
 *   doc?: Document,
 * }} o
 */
export function createPicker(o) {
  const doc = o.doc ?? document;
  /** @type {HTMLElement | null} */
  let host = null;
  /** @type {ShadowRoot | null} */
  let root = null;
  let results = [];
  let index = 0;
  /** The picker field that should have the keyboard (search box, then variable inputs). */
  /** @type {HTMLInputElement | null} */
  let field = null;
  /** @type {(() => void) | null} */
  let unguard = null;

  function close() {
    unguard?.();
    unguard = null;
    host?.remove();
    host = null;
    root = null;
    field = null;
  }

  /** @param {HTMLInputElement} el */
  function focusField(el) {
    field = el;
    el.focus();
  }

  /**
   * claude.ai's editor can take the focus back, and the page listens for keys at document level. While the
   * picker is open: (1) our own key and input events stop at the picker host so the page never sees them;
   * (2) keys that still reach the message box are blocked there and replayed into the picker field, so
   * nothing typed for the picker lands in (or sends) the message.
   */
  function guard() {
    const stop = (e) => e.stopPropagation();
    const kinds = ['keydown', 'keyup', 'keypress', 'beforeinput', 'input', 'paste', 'compositionstart', 'compositionend'];
    for (const k of kinds) host.addEventListener(k, stop);
    const inComposer = (e) => {
      const c = o.getComposer();
      return Boolean(c && e.target instanceof Node && (c === e.target || c.contains(e.target)));
    };
    const onKey = (e) => {
      if (!field || !inComposer(e)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.type !== 'keydown') return;
      focusField(field);
      if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        field.value += e.key;
        field.dispatchEvent(new Event('input'));
      } else if (e.key === 'Backspace') {
        field.value = field.value.slice(0, -1);
        field.dispatchEvent(new Event('input'));
      } else {
        field.dispatchEvent(new KeyboardEvent('keydown', { key: e.key, cancelable: true }));
      }
    };
    const onBeforeInput = (e) => {
      if (field && inComposer(e)) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    };
    doc.addEventListener('keydown', onKey, true);
    doc.addEventListener('keypress', onKey, true);
    doc.addEventListener('beforeinput', onBeforeInput, true);
    // The editor may grab focus right after it handles the ";;" input: take it back once things settle.
    const refocus = setTimeout(() => field && doc.activeElement !== host && focusField(field), 50);
    return () => {
      clearTimeout(refocus);
      doc.removeEventListener('keydown', onKey, true);
      doc.removeEventListener('keypress', onKey, true);
      doc.removeEventListener('beforeinput', onBeforeInput, true);
    };
  }

  function position(box) {
    const c = o.getComposer();
    const r = c?.getBoundingClientRect?.();
    const top = r && r.top > 360 ? r.top - 350 : 80;
    box.style.top = `${Math.max(8, top)}px`;
    box.style.left = `${Math.max(8, r ? r.left : 40)}px`;
  }

  async function open() {
    if (host || doc.getElementById('resync-quick-picker')) return; // only one picker on the page
    const prompts = await o.getPrompts();
    host = doc.createElement('div');
    host.id = 'resync-quick-picker';
    root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>${CSS}</style><div class="box" role="dialog" aria-label="ReSync prompts"><input aria-label="Search prompts" placeholder="Search saved prompts..." /><ul role="listbox"></ul><div class="hint">Enter to insert, Esc to close</div></div>`;
    doc.body.appendChild(host);
    const box = /** @type {HTMLElement} */ (root.querySelector('.box'));
    position(box);
    const input = /** @type {HTMLInputElement} */ (root.querySelector('input'));
    const render = () => {
      results = searchPrompts(prompts, { text: input.value }).slice(0, 8);
      index = Math.min(index, Math.max(0, results.length - 1));
      const ul = root.querySelector('ul');
      ul.innerHTML = '';
      results.forEach((p, i) => {
        const li = doc.createElement('li');
        li.setAttribute('role', 'option');
        li.setAttribute('aria-selected', String(i === index));
        li.innerHTML = `<div></div><div class="meta"></div>`;
        li.firstChild.textContent = p.title;
        li.lastChild.textContent = `${p.category} · ${p.scope}${p.steps.length ? ` · chain (${p.steps.length} steps)` : ''}`;
        li.addEventListener('mousedown', (e) => {
          e.preventDefault();
          choose(p);
        });
        ul.appendChild(li);
      });
      if (!results.length) ul.innerHTML = '<li aria-disabled="true">No matching prompts</li>';
    };
    input.addEventListener('input', () => {
      index = 0;
      render();
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') index = Math.min(index + 1, results.length - 1);
      else if (e.key === 'ArrowUp') index = Math.max(index - 1, 0);
      else if (e.key === 'Enter' && results[index]) {
        e.preventDefault();
        choose(results[index]);
        return;
      } else if (e.key === 'Escape') {
        close();
        o.getComposer()?.focus?.();
        return;
      } else return;
      e.preventDefault();
      render();
    });
    render();
    unguard = guard();
    focusField(input);
  }

  /** @param {import('@resync/shared/prompts').Prompt} p */
  function choose(p) {
    const text = promptText(p);
    const needed = p.variables;
    if (!needed.length) return finish(text, p);
    const box = root.querySelector('.box');
    box.innerHTML = '';
    const title = doc.createElement('strong');
    title.textContent = p.title;
    box.appendChild(title);
    const inputs = needed.map((v, i) => {
      const label = doc.createElement('label');
      label.textContent = `${v.name}${v.description ? ` (${v.description})` : ''}`;
      const input = doc.createElement('input');
      input.name = v.name;
      input.value = v.default ?? '';
      input.setAttribute('aria-label', v.name);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          if (i === needed.length - 1) submitForm();
          else inputs[i + 1].focus();
        }
        if (e.key === 'Escape') {
          close();
          o.getComposer()?.focus?.();
        }
      });
      input.addEventListener('focus', () => {
        field = input;
      });
      box.append(label, input);
      return input;
    });
    const btn = doc.createElement('button');
    btn.textContent = 'Insert';
    const submitForm = () => {
      // Never insert a prompt with an unfilled {{variable}}: point at the first empty one instead.
      const empty = inputs.find((x, i) => !x.value.trim() && needed[i].default == null);
      if (empty) {
        empty.setAttribute('aria-invalid', 'true');
        empty.placeholder = 'Required';
        return focusField(empty);
      }
      finish(renderVariables(text, Object.fromEntries(inputs.map((x) => [x.name, x.value])), { defaults: needed }), p);
    };
    btn.addEventListener('click', submitForm);
    box.appendChild(btn);
    focusField(inputs[0]);
  }

  /** @param {string} text @param {import('@resync/shared/prompts').Prompt} p */
  function finish(text, p) {
    const c = o.getComposer();
    close();
    if (!c) return;
    removeTrigger(c, TRIGGER);
    const current = readText(c).trim();
    insertText(c, current ? `\n${text}` : text);
    if (p.steps.length > 1) {
      // Chains run from the side panel so each step waits for the reply; here we only insert step 1.
      console.info('[resync] Inserted step 1 of a chain. Run the full chain from the ReSync side panel.');
    }
  }

  /** Watch the composer for the trigger. Returns a function that stops watching. */
  function attach() {
    const onInput = (e) => {
      const c = o.getComposer();
      if (!c || !(e.target instanceof Node) || !(c === e.target || c.contains(e.target))) return;
      if (readText(c).replace(/\s+$/, '').endsWith(TRIGGER)) open();
    };
    doc.addEventListener('input', onInput, true);
    return () => doc.removeEventListener('input', onInput, true);
  }

  return { attach, open, close, get isOpen() { return Boolean(host); } };
}
