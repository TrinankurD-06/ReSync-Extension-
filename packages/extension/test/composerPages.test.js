// The message box on every page type (fixtures in test/fixtures/claude-pages/), SPA navigation from a chat to a
// project home page, verified insertion, and the clipboard fallback.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findComposer, pageType, query, healthCheck, watchUrl, NAVIGATE_EVENT } from '../src/lib/selectors.js';
import { insertAndVerify, readText } from '../src/lib/composer.js';
import { deliverText, trackFocus, FALLBACK_ID, NOT_FOUND_MESSAGE } from '../src/content/deliver.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => readFileSync(path.join(here, 'fixtures/claude-pages', `${name}.html`), 'utf8');

/** Load a fixture as the current page at a URL path. */
function load(name, pathname) {
  const html = fixture(name);
  document.head.innerHTML = /<head>([\s\S]*?)<\/head>/i.exec(html)?.[1] ?? '';
  document.body.innerHTML = /<body>([\s\S]*?)<\/body>/i.exec(html)?.[1] ?? '';
  history.replaceState(null, '', pathname);
}

/**
 * Make the page behave like claude.ai's editor: a ProseMirror-like editor takes pasted text, and the send button
 * stays disabled until the editor has text.
 */
function liveEditor(el) {
  const btn = el.closest('fieldset, .composer-card, main')?.querySelector('button[aria-label="Send message"]');
  const sync = () => btn && (btn.disabled = !el.textContent.trim());
  el.addEventListener('paste', (e) => {
    e.preventDefault();
    el.innerHTML = '';
    for (const line of e.clipboardData.getData('text/plain').split('\n')) {
      const p = document.createElement('p');
      p.textContent = line;
      el.appendChild(p);
    }
    sync();
  });
  el.addEventListener('input', sync);
  return btn;
}

const PAGES = [
  ['project-home', '/project/p1', 'project-home'],
  ['new-chat', '/new', 'new-chat'],
  ['chat', '/chat/c1', 'chat'],
  ['project-chat', '/chat/c1', 'chat'],
];

beforeEach(() => {
  document.getElementById(FALLBACK_ID)?.remove();
  vi.restoreAllMocks();
});

describe('page types', () => {
  it('come from the URL', () => {
    expect(pageType('/project/0192abc')).toBe('project-home');
    expect(pageType('/project/0192abc/')).toBe('project-home');
    expect(pageType('/new')).toBe('new-chat');
    expect(pageType('/chat/abc-123')).toBe('chat');
    expect(pageType('/projects')).toBe('other');
    expect(pageType('/settings/profile')).toBe('other');
  });
});

describe.each(PAGES)('composer on the %s fixture', (name, pathname, type) => {
  it('is found: the visible one in the main area, never a panel editor or a hidden copy', () => {
    load(name, pathname);
    const found = findComposer();
    expect(found?.page).toBe(type);
    expect(found?.el.getAttribute('data-expect')).toBe('composer');
    expect(healthCheck().missing).not.toContain('composer');
  });

  it('takes inserted text, and the send button turns on', async () => {
    load(name, pathname);
    const el = findComposer().el;
    const btn = liveEditor(el);
    expect(btn.disabled).toBe(true);
    const r = await insertAndVerify(el, 'Continue from this handoff brief:\n\n## Goal\nShip the site', { replace: true, wait: async () => {} });
    expect(r).toMatchObject({ ok: true, present: true, sendReady: true });
    expect(readText(el)).toContain('Continue from this handoff brief:');
    expect(btn.disabled).toBe(false);
  });
});

describe('project home page (the bug)', () => {
  it('the old single selector list picked the wrong element there', () => {
    load('project-home', '/project/p1');
    // The generic list (what ReSync used on every page before) hits the hidden duplicate first.
    expect(query('composer')?.getAttribute('data-expect')).not.toBe('composer');
    expect(findComposer().el.getAttribute('data-expect')).toBe('composer');
  });

  it('skips the Instructions and Memory editors even when the composer card is missing', () => {
    load('project-home', '/project/p1');
    document.querySelector('.composer-card').remove();
    expect(findComposer()).toBeNull();
  });

  it('a user override still goes first', () => {
    load('project-home', '/project/p1');
    const found = findComposer({ overrides: { composer: ['main .composer-card [contenteditable]'] } });
    expect(found.selector).toBe('main .composer-card [contenteditable]');
    expect(found.el.getAttribute('data-expect')).toBe('composer');
  });
});

describe('single-page navigation from a chat to a project home page', () => {
  it('sees pushState through the main-world nav hook, waits for the composer to mount, and inserts', async () => {
    load('chat', '/chat/c1');
    // public/nav-hook.js runs in the page's own world in Chrome; here there is only one world.
    new Function(readFileSync(path.join(here, '../public/nav-hook.js'), 'utf8'))();
    const events = [];
    document.addEventListener(NAVIGATE_EVENT, () => events.push(location.pathname));
    const urls = [];
    const stop = watchUrl((href) => urls.push(new URL(href).pathname));

    // claude.ai navigates in-app, then renders the project page; the composer card arrives a moment later.
    history.pushState(null, '', '/project/p1');
    const page = fixture('project-home');
    document.head.innerHTML = /<head>([\s\S]*?)<\/head>/i.exec(page)[1]; // its stylesheet hides the duplicate composer
    document.body.innerHTML = /<body>([\s\S]*?)<\/body>/i.exec(page)[1];
    const card = document.querySelector('.composer-card');
    card.remove();
    expect(events).toEqual(['/project/p1']);
    expect(urls).toEqual(['/project/p1']);

    const pending = deliverText('Continue from this handoff brief:\n\n## Goal\nShip it', { replace: true, timeoutMs: 3000, wait: async () => {} });
    await new Promise((r) => setTimeout(r, 120));
    liveEditor(card.querySelector('[contenteditable]')); // the editor behaves like this as soon as it mounts
    document.querySelector('.project-main').prepend(card);
    const r = await pending;
    expect(r).toMatchObject({ ok: true, page: 'project-home', sendReady: true, sent: false });
    expect(card.querySelector('[data-expect]').textContent).toContain('Continue from this handoff brief:');
    expect(document.querySelector('[aria-label="Edit project instructions"]').textContent).toBe('Write in a friendly tone.');
    stop();
  });

  it('back/forward (popstate) is seen too', () => {
    load('chat', '/chat/c1');
    const urls = [];
    const stop = watchUrl((href) => urls.push(new URL(href).pathname));
    history.replaceState(null, '', '/project/p1');
    window.dispatchEvent(new PopStateEvent('popstate'));
    expect(urls).toEqual(['/project/p1']);
    stop();
  });

  it('auto-send presses Send only when asked', async () => {
    load('project-home', '/project/p1');
    const el = findComposer().el;
    const btn = liveEditor(el);
    const clicks = [];
    btn.addEventListener('click', () => clicks.push(readText(el)));
    expect((await deliverText('brief', { replace: true, wait: async () => {} })).sent).toBe(false);
    expect(clicks).toEqual([]);
    expect((await deliverText('brief two', { replace: true, autoSend: true, wait: async () => {} })).sent).toBe(true);
    expect(clicks[0]).toContain('brief two');
  });
});

describe('fallback when the message box cannot be found or filled', () => {
  it('shows the message, copies the text, and Retry uses the box the user clicked into', async () => {
    document.head.innerHTML = '';
    document.body.innerHTML = '<main><p>Loading...</p></main>';
    history.replaceState(null, '', '/project/p1');
    const copied = [];
    vi.spyOn(navigator.clipboard, 'writeText').mockImplementation(async (t) => void copied.push(t));
    trackFocus();

    const r = await deliverText('keep this text', { timeoutMs: 150, wait: async () => {} });
    expect(r.ok).toBe(false);
    expect(r.error).toContain(NOT_FOUND_MESSAGE);
    expect(r.copied).toBe(true);
    expect(copied).toEqual(['keep this text']);
    const box = document.getElementById(FALLBACK_ID);
    expect(box.textContent).toContain("Couldn't find the message box. Click into it and press Retry");

    // The user clicks into a box ReSync didn't recognise, then presses Retry.
    document.querySelector('main').insertAdjacentHTML('beforeend', '<textarea data-resync-ignore></textarea>');
    const ta = document.querySelector('textarea');
    ta.focus();
    ta.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    [...box.querySelectorAll('button')].find((b) => b.textContent === 'Retry').click();
    await vi.waitFor(() => expect(ta.value).toBe('keep this text'));
    expect(document.getElementById(FALLBACK_ID)).toBeNull();
  });

  it('falls back when the editor ignores the text (Send stays disabled)', async () => {
    load('chat', '/chat/c1');
    vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
    const el = findComposer().el;
    el.addEventListener('paste', (e) => e.preventDefault()); // swallows the paste and keeps Send disabled
    const r = await deliverText('lost?', { timeoutMs: 100, wait: async () => {} });
    expect(r.ok).toBe(false);
    expect(r.copied).toBe(true);
    expect(document.getElementById(FALLBACK_ID)).not.toBeNull();
  });

  it('still explains what to do when the clipboard is refused', async () => {
    document.body.innerHTML = '<main></main>';
    history.replaceState(null, '', '/new');
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'));
    const r = await deliverText('x', { timeoutMs: 100 });
    expect(r).toMatchObject({ ok: false, copied: false });
    expect(r.error).toBe(`${NOT_FOUND_MESSAGE}.`);
  });
});
