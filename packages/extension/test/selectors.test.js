import { describe, it, expect, beforeEach } from 'vitest';
import { query, queryAll, healthCheck, isStreaming, findAlert, selectorList, isChatPage } from '../src/lib/selectors.js';
import { renderBanner, runHealthCheck } from '../src/content/health.js';

beforeEach(() => {
  document.body.innerHTML = '';
});

const page = (html) => {
  document.body.innerHTML = html;
};

describe('claude.ai selectors', () => {
  it('finds the composer through fallbacks', () => {
    page('<fieldset><div contenteditable="true" class="ProseMirror"></div></fieldset>');
    expect(query('composer')?.className).toBe('ProseMirror');
    page('<textarea placeholder="Reply"></textarea>');
    expect(query('composer')?.tagName).toBe('TEXTAREA');
    page('<div></div>');
    expect(query('composer')).toBeNull();
  });

  it('puts user overrides first and skips invalid ones', () => {
    page('<div id="mine" contenteditable="true"></div><textarea placeholder="x"></textarea>');
    expect(query('composer', { overrides: { composer: '#mine' } })?.id).toBe('mine');
    expect(query('composer', { overrides: { composer: ['((bad', '#mine'] } })?.id).toBe('mine');
    expect(selectorList('composer', { composer: '#a' })[0]).toBe('#a');
  });

  it('reports missing elements in the health check, per page type', () => {
    page('<nav><a href="/chat/1">One</a></nav>');
    expect(healthCheck({ pathname: '/recents' })).toEqual({ ok: true, missing: [], page: 'other' });
    expect(healthCheck({ pathname: '/chat/1' })).toEqual({ ok: false, missing: ['composer'], page: 'chat' });
    page('');
    expect(healthCheck({ pathname: '/chat/1' }).missing).toEqual(['sidebarChatLink', 'composer']);
  });

  it('detects streaming via the stop button or a streaming marker', () => {
    page('<button aria-label="Stop response"></button>');
    expect(isStreaming()).toBe(true);
    page('<div data-is-streaming="true"></div>');
    expect(isStreaming()).toBe(true);
    page('<div data-is-streaming="false"></div><button aria-label="Send message"></button>');
    expect(isStreaming()).toBe(false);
  });

  it('classifies alerts as limit or error', () => {
    page('<div role="alert">You’ve hit your session limit · resets 3:45pm</div>');
    expect(findAlert()).toMatchObject({ kind: 'limit' });
    page('<div role="alert">Something went wrong. Try again.</div>');
    expect(findAlert()).toMatchObject({ kind: 'error' });
    page('<div class="font-claude-response">Here is a long helpful answer about limits in calculus.</div>');
    expect(findAlert()).toBeNull();
    page('<div class="font-claude-response">You have reached the message limit. Resets at 5pm.</div>');
    expect(findAlert()).toMatchObject({ kind: 'limit' });
  });

  it('shows a clear, dismissible banner when a selector breaks, and removes it when fixed', () => {
    const el = renderBanner({ ok: false, missing: ['composer'] });
    expect(el.textContent).toMatch(/can't find the message box/);
    expect(el.getAttribute('role')).toBe('status');
    el.querySelector('button').click();
    expect(el.style.display).toBe('none');
    expect(renderBanner({ ok: false, missing: ['composer'] }).style.display).toBe('none'); // stays dismissed
    expect(renderBanner({ ok: true, missing: [] })).toBeNull();
    expect(document.getElementById('resync-health-banner')).toBeNull();
  });

  it('runHealthCheck reports the result to the extension', () => {
    page('<nav><a href="/chat/1">x</a></nav>');
    const sent = [];
    const r = runHealthCheck({ send: (m) => sent.push(m) });
    expect(r.ok).toBe(true);
    expect(sent[0]).toMatchObject({ type: 'resync:health', result: { ok: true } });
  });

  it('lists sidebar links and recognises chat pages', () => {
    page('<nav><a href="/project/p1">P</a><a href="/chat/c1">C</a><a href="/chat/c2">D</a></nav>');
    expect(queryAll('sidebarChatLink')).toHaveLength(2);
    expect(queryAll('sidebarProjectLink')).toHaveLength(1);
    expect([isChatPage('/chat/abc'), isChatPage('/new'), isChatPage('/projects'), isChatPage('/project/x')]).toEqual([true, true, false, true]);
  });
});
