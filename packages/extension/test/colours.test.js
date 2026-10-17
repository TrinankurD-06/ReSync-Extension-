import { describe, it, expect, beforeEach } from 'vitest';
import { PRESETS, itemKey, listSidebarItems, applyColours, colourById } from '../src/lib/colours.js';

beforeEach(() => {
  document.body.innerHTML = `<nav>
    <a href="/project/p1">Launch site</a>
    <a href="/chat/c1">Pricing chat</a>
    <a href="/chat/c2">Other</a>
    <a href="/chat/c1">Pricing chat (dup)</a>
  </nav>`;
});

describe('project colours', () => {
  it('has Startup and Personal presets', () => {
    expect(Object.values(PRESETS).map((p) => p.label)).toEqual(['Startup', 'Personal']);
    expect(colourById('growth').colour).toMatch(/^#/);
    expect(colourById('nope')).toBeNull();
  });

  it('keys sidebar items by project/chat id and lists them once', () => {
    expect(itemKey('/project/abc-1')).toBe('project:abc-1');
    expect(itemKey('/recents')).toBeNull();
    expect(listSidebarItems()).toEqual([
      { key: 'project:p1', kind: 'project', title: 'Launch site' },
      { key: 'chat:c1', kind: 'chat', title: 'Pricing chat' },
      { key: 'chat:c2', kind: 'chat', title: 'Other' },
    ]);
  });

  it('paints assigned items and clears removed assignments', () => {
    expect(applyColours({ 'project:p1': 'growth', 'chat:c1': 'ideas' })).toBe(3);
    const [p1, c1] = document.querySelectorAll('a');
    expect(p1.getAttribute('data-resync-colour')).toBe('growth');
    expect(p1.style.boxShadow).toContain('3px');
    expect(c1.title).toBe('Ideas (ReSync)');
    applyColours({ 'project:p1': 'growth' });
    expect(c1.hasAttribute('data-resync-colour')).toBe(false);
    expect(c1.style.boxShadow).toBe('');
  });
});
