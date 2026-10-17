import { describe, it, expect, beforeEach } from 'vitest';
import { insertText, readText, removeTrailing, submit } from '../src/lib/composer.js';

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('composer', () => {
  it('fills a textarea via the native setter and fires input', () => {
    document.body.innerHTML = '<textarea placeholder="Reply"></textarea>';
    const ta = document.querySelector('textarea');
    const seen = [];
    ta.addEventListener('input', () => seen.push(ta.value));
    expect(insertText(ta, 'Hello')).toBe('textarea');
    insertText(ta, ' world');
    expect(readText(ta)).toBe('Hello world');
    insertText(ta, 'new', { replace: true });
    expect(readText(ta)).toBe('new');
    expect(seen).toEqual(['Hello', 'Hello world', 'new']);
  });

  it('uses a paste event when the editor handles it (ProseMirror-like)', () => {
    document.body.innerHTML = '<div contenteditable="true" class="ProseMirror"><p>Hi </p></div>';
    const ed = document.querySelector('.ProseMirror');
    // Simulate an editor that inserts pasted text itself.
    ed.addEventListener('paste', (e) => {
      e.preventDefault();
      const text = e.clipboardData.getData('text/plain');
      for (const line of text.split('\n')) {
        const p = document.createElement('p');
        p.textContent = line;
        ed.appendChild(p);
      }
    });
    const how = insertText(ed, 'line one\nline two');
    expect(['paste', 'dom']).toContain(how); // paste needs DataTransfer support in the test DOM
    expect(ed.textContent).toContain('line one');
    expect(ed.textContent).toContain('line two');
  });

  it('falls back to writing paragraphs when the editor ignores events', () => {
    document.body.innerHTML = '<div contenteditable="true"></div>';
    const ed = document.querySelector('[contenteditable]');
    let inputs = 0;
    ed.addEventListener('input', () => inputs++);
    insertText(ed, 'a\nb', { replace: true });
    expect([...ed.querySelectorAll('p')].map((p) => p.textContent)).toEqual(['a', 'b']);
    expect(inputs).toBeGreaterThan(0);
  });

  it('removes a trailing ;; trigger', () => {
    document.body.innerHTML = '<textarea placeholder="x"></textarea>';
    const ta = document.querySelector('textarea');
    insertText(ta, 'Please help;;');
    expect(removeTrailing(ta, ';;')).toBe(true);
    expect(readText(ta)).toBe('Please help');
    expect(removeTrailing(ta, ';;')).toBe(false);
  });

  it('submits via the send button, or Enter when there is none', () => {
    document.body.innerHTML = '<textarea placeholder="x"></textarea><button aria-label="Send message">Send</button>';
    let clicked = 0;
    document.querySelector('button').addEventListener('click', () => clicked++);
    expect(submit()).toBe(true);
    expect(clicked).toBe(1);
    document.body.innerHTML = '<textarea placeholder="x"></textarea>';
    const keys = [];
    document.querySelector('textarea').addEventListener('keydown', (e) => keys.push(e.key));
    expect(submit()).toBe(true);
    expect(keys).toEqual(['Enter']);
    document.body.innerHTML = '';
    expect(submit()).toBe(false);
  });
});
