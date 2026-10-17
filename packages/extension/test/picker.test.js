import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPicker } from '../src/content/picker.js';
import { insertText } from '../src/lib/composer.js';
import { loadLibraryFromDir } from '@resync/shared/node/library';

const SEEDS = (await loadLibraryFromDir(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../prompts'))).prompts;
let picker;
let ta;

const shadow = () => document.getElementById('resync-quick-picker')?.shadowRoot;
const flush = () => new Promise((r) => setTimeout(r, 0));
const key = (el, k) => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));

let detach;
beforeEach(() => {
  document.body.innerHTML = '<textarea placeholder="Reply"></textarea>';
  ta = document.querySelector('textarea');
  picker = createPicker({ getPrompts: async () => SEEDS, getComposer: () => document.querySelector('textarea') });
  detach = picker.attach();
});
afterEach(() => detach());

describe(';; quick picker', () => {
  it('opens when ;; is typed in the composer, not elsewhere', async () => {
    insertText(ta, 'hello');
    await flush();
    expect(picker.isOpen).toBe(false);
    insertText(ta, ';;');
    await flush();
    expect(picker.isOpen).toBe(true);
    expect(shadow().querySelectorAll('li').length).toBeGreaterThan(0);
    picker.close();
  });

  it('fills {{variables}} through the form and replaces the ;; trigger', async () => {
    insertText(ta, 'Context first. ;;');
    await flush();
    const input = shadow().querySelector('input');
    input.value = 'explain concept';
    input.dispatchEvent(new Event('input'));
    expect(shadow().querySelector('li').textContent).toContain('Explain a concept');
    key(input, 'Enter');
    const field = shadow().querySelector('input[name="concept"]');
    expect(field).toBeTruthy();
    field.value = 'recursion';
    key(field, 'Enter');
    expect(picker.isOpen).toBe(false);
    expect(ta.value).toContain('Context first.');
    expect(ta.value).not.toContain(';;');
    expect(ta.value).toContain('Explain recursion three times');
  });

  it('uses defaults for empty fields and closes on Escape', async () => {
    insertText(ta, ';;');
    await flush();
    const input = shadow().querySelector('input');
    input.value = 'flashcards';
    input.dispatchEvent(new Event('input'));
    key(input, 'Enter');
    const fields = shadow().querySelectorAll('input');
    fields[0].value = 'photosynthesis notes'; // material; count keeps its default "10"
    shadow().querySelector('button').click();
    expect(ta.value).toContain('Make 10 flashcards');
    expect(ta.value).toContain('photosynthesis notes');

    insertText(ta, ' ;;');
    await flush();
    key(shadow().querySelector('input'), 'Escape');
    expect(picker.isOpen).toBe(false);
  });

  it('arrow keys move the selection', async () => {
    insertText(ta, ';;');
    await flush();
    const input = shadow().querySelector('input');
    key(input, 'ArrowDown');
    const items = [...shadow().querySelectorAll('li')];
    expect(items[1].getAttribute('aria-selected')).toBe('true');
    key(input, 'ArrowUp');
    expect(shadow().querySelectorAll('li')[0].getAttribute('aria-selected')).toBe('true');
    picker.close();
  });
});
