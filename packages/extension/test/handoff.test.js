// Chat Health Meter (states at thresholds, snooze, per-chat counts) and the one-click handoff up to pasting the
// brief into the project home page's message box, with links both ways between the chats.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chatHealthState, defaultThresholds, normaliseThresholds, createSnoozes, shouldNudge, chatKeyOf, HEALTH_TOOLTIP } from '../src/lib/chatHealth.js';
import { createHandoffs, runHandoff, handoffTarget, HANDOFF_PREFIX } from '../src/lib/handoff.js';
import { createArtifacts } from '../src/lib/artifacts.js';
import { createLedger } from '../src/lib/ledger.js';
import { setPendingInsert, takePendingInsertItem } from '../src/content/conversation.js';
import { createUsageTracker } from '../src/content/usageTracker.js';
import { createUsageStore } from '../src/lib/usageEstimates.js';
import { normaliseSettings } from '../src/lib/settings.js';
import { deliverText } from '../src/content/deliver.js';
import { renderBadge, BADGE_ID } from '../src/content/badge.js';
import { memoryArea } from './fakeChrome.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const stats = (o) => ({ chat: 'https://claude.ai/chat/c1', project: 'Launch site', tokens: 0, turns: 0, attachments: 0, ...o });

describe('chat health states', () => {
  const t = defaultThresholds();
  it('green below amber, amber at the amber line, red at the red line; the worst measure wins', () => {
    expect(chatHealthState(stats({ tokens: t.amber.tokens - 1, turns: t.amber.turns - 1 })).level).toBe('green');
    expect(chatHealthState(stats({ tokens: t.amber.tokens })).level).toBe('amber');
    expect(chatHealthState(stats({ tokens: t.red.tokens - 1 })).level).toBe('amber');
    expect(chatHealthState(stats({ tokens: t.red.tokens })).level).toBe('red');
    expect(chatHealthState(stats({ turns: t.red.turns, tokens: 10 })).level).toBe('red');
    const h = chatHealthState(stats({ attachments: t.amber.attachments, turns: t.red.turns }));
    expect(h.level).toBe('red');
    expect(h.reasons).toEqual([`${t.red.turns} turns (red from ${t.red.turns})`, `${t.amber.attachments} attachments (amber from ${t.amber.attachments})`]);
  });

  it('a long chat crosses amber then red as it grows', () => {
    const seen = [];
    for (let tokens = 0; tokens <= 150_000; tokens += 10_000) seen.push(chatHealthState(stats({ tokens })).level);
    expect([...new Set(seen)]).toEqual(['green', 'amber', 'red']);
  });

  it('thresholds are settings (model-agnostic numbers); red is never below amber', () => {
    const custom = normaliseSettings({ chatHealth: { amber: { tokens: 1000 }, red: { tokens: 500, turns: 'x' } } }).chatHealth;
    expect(custom.amber.tokens).toBe(1000);
    expect(custom.red.tokens).toBe(1000);
    expect(custom.red.turns).toBe(t.red.turns);
    expect(chatHealthState(stats({ tokens: 1000 }), custom).level).toBe('red');
    expect(normaliseThresholds(null)).toEqual(t);
    expect(normaliseSettings(null).handoff.autoSend).toBe(false);
  });

  it('snoozing a chat stops the nudge there only (query strings ignored)', async () => {
    const s = createSnoozes(memoryArea());
    const red = chatHealthState(stats({ tokens: 500_000 }));
    expect(shouldNudge(red, await s.isSnoozed('https://claude.ai/chat/c1'))).toBe(true);
    await s.snooze('https://claude.ai/chat/c1?foo=1');
    expect(shouldNudge(red, await s.isSnoozed('https://claude.ai/chat/c1'))).toBe(false);
    expect(await s.isSnoozed('https://claude.ai/chat/c2')).toBe(false);
    expect(shouldNudge(chatHealthState(stats({ tokens: 70_000 })), false)).toBe(false); // amber never nudges
    await s.unsnooze('https://claude.ai/chat/c1');
    expect(await s.isSnoozed('https://claude.ai/chat/c1')).toBe(false);
  });

  it('the page badge is small, explains itself, and only nudges when asked', () => {
    document.body.innerHTML = '';
    const el = renderBadge(chatHealthState(stats({ tokens: 500_000 })), { nudge: true });
    expect(el.dataset.level).toBe('red');
    expect(el.title).toContain(HEALTH_TOOLTIP);
    expect(el.textContent).toBe('Long chat: hand off?');
    renderBadge(chatHealthState(stats({ tokens: 500_000 })), { nudge: false });
    expect(document.getElementById(BADGE_ID).textContent).toBe('Long chat');
    renderBadge(null);
    expect(document.getElementById(BADGE_ID)).toBeNull();
  });
});

describe('per-chat counts for the meter', () => {
  it('count turns and attachments as the chat grows, and survive a reload', async () => {
    document.body.innerHTML = '<main id="t"></main>';
    history.replaceState(null, '', '/chat/c1');
    const area = memoryArea();
    const usage = createUsageStore(area);
    const seen = [];
    const make = () => createUsageTracker({ add: (e) => usage.add(e), getOverrides: () => ({}), memory: usage, projectName: () => 'Launch site', onStats: (s) => seen.push(s), onMessage: (m) => seen.push(m) });
    const tracker = make();
    await tracker.baseline();
    const t = document.getElementById('t');
    t.insertAdjacentHTML('beforeend', '<div data-test-render-count="1"><div data-testid="user-message">Plan the launch</div><div data-testid="file-thumbnail"><img alt="image"></div></div>');
    await tracker.scan();
    t.insertAdjacentHTML('beforeend', '<div class="font-claude-response" data-is-streaming="false"><p>Here is a plan.</p></div>');
    await tracker.scan();
    expect(tracker.stats()).toMatchObject({ chatId: 'c1', turns: 2, attachments: 1 });
    expect(tracker.stats().tokens).toBeGreaterThan(1000); // the image counts towards what the chat re-reads
    expect(seen.filter((x) => x.role).map((x) => x.role)).toEqual(['user', 'assistant']); // new messages go to the ledger check

    // Reload with only the last message rendered: the saved counts win.
    t.innerHTML = '<div class="font-claude-response" data-is-streaming="false"><p>Here is a plan.</p></div>';
    const again = make();
    await again.baseline();
    expect(again.stats()).toMatchObject({ turns: 2, attachments: 1 });
  });
});

const PASSPORT_REPLY = `## Meta
- Date: 2026-10-21
## Goal
Ship the site.
## Current state
Drafts done.
## Decisions made (and why)
- Use PostgreSQL for the main database — because the team already knows it
- Launch on 4 November — because the conference starts that week
- Offer a free tier (assumed) — because competitors do
## Open questions
None
## Dead ends
None
## Next 3 steps
1. Pricing page
2. Hosting
3. Launch post
## Key files
None`;

function deps(area, over = {}) {
  const calls = [];
  return {
    calls,
    d: {
      runPassport: async () => (calls.push('passport'), { ok: true, text: PASSPORT_REPLY, mode: 'in-chat', meta: { date: '2026-10-21', project: 'Launch site', source: 'https://claude.ai/chat/c1', projectUrl: 'https://claude.ai/project/p1' } }),
      artifacts: createArtifacts(area),
      ledger: createLedger(area),
      handoffs: createHandoffs(area),
      setPendingInsert: async (text, extra) => (calls.push('pending'), setPendingInsert(text, area, extra)),
      navigate: async (url) => void calls.push(`open ${url}`),
      author: 'Asha',
      onStep: (s) => calls.push(`step ${s}`),
      ...over,
    },
  };
}

describe('one-click handoff', () => {
  it('passport -> saved and linked -> decisions in the ledger -> new chat in the same project -> brief pasted (not sent)', async () => {
    const area = memoryArea();
    const { d, calls } = deps(area);
    const r = await runHandoff(d);
    expect(calls).toEqual(['step passport', 'passport', 'step saving', 'step opening', 'pending', 'open https://claude.ai/project/p1']);
    expect(r.targetUrl).toBe('https://claude.ai/project/p1');

    const [saved] = await d.artifacts.list();
    expect(saved).toMatchObject({ kind: 'passport', data: { sourceChat: 'https://claude.ai/chat/c1', handoffId: r.handoff.id } });
    expect(saved.content).toContain('- Source: https://claude.ai/chat/c1');
    const decisions = await d.ledger.list();
    expect(decisions.map((x) => x.status).sort()).toEqual(['active', 'active', 'pending']);
    expect(decisions.every((x) => x.sourceChat === 'https://claude.ai/chat/c1' && x.author === 'Asha')).toBe(true);
    expect(r.handoff).toMatchObject({ sourceChat: 'https://claude.ai/chat/c1', targetUrl: 'https://claude.ai/project/p1', newChat: '', passportId: saved.id });

    // The new tab lands on the project home page; the content script delivers the pending brief there.
    const html = readFileSync(path.join(here, 'fixtures/claude-pages/project-home.html'), 'utf8');
    document.head.innerHTML = /<head>([\s\S]*?)<\/head>/i.exec(html)[1];
    document.body.innerHTML = /<body>([\s\S]*?)<\/body>/i.exec(html)[1];
    history.replaceState(null, '', '/project/p1');
    const item = await takePendingInsertItem(area);
    expect(item).toMatchObject({ autoSend: false, handoffId: r.handoff.id });
    expect(item.text.startsWith(`${HANDOFF_PREFIX}\n\n# Context Passport`)).toBe(true);
    // Like claude.ai's editor: Send turns on once the editor has text.
    const box = document.querySelector('[data-expect="composer"]');
    const send = document.querySelector('[aria-label="Send message"]');
    box.addEventListener('input', () => (send.disabled = !box.textContent.trim()));
    const sent = [];
    send.addEventListener('click', () => sent.push(1));
    const delivered = await deliverText(item.text, { replace: true, autoSend: item.autoSend, wait: async () => {} });
    expect(delivered).toMatchObject({ ok: true, page: 'project-home', sent: false });
    expect(box.textContent).toContain('Continue from this handoff brief:');
    expect(box.textContent).toContain('Use PostgreSQL for the main database');
    expect(sent).toEqual([]);
  });

  it('auto-send is passed through when turned on; chats outside a project open a plain new chat', async () => {
    const area = memoryArea();
    const { d, calls } = deps(area, { autoSend: true });
    d.runPassport = async () => ({ ok: true, text: PASSPORT_REPLY, mode: 'in-chat', meta: { date: '2026-10-21', project: 'No project', source: 'https://claude.ai/chat/c9', projectUrl: '' } });
    await runHandoff(d);
    expect(calls.at(-1)).toBe('open https://claude.ai/new');
    expect((await takePendingInsertItem(area)).autoSend).toBe(true);
    expect(handoffTarget({ projectUrl: 'https://evil.example/project/p1' })).toBe('https://claude.ai/new');
  });

  it('stops before saving or navigating when the passport fails', async () => {
    const area = memoryArea();
    const { d, calls } = deps(area, { runPassport: async () => ({ ok: false, error: 'ReSync can\'t find the message box on this page.' }) });
    await expect(runHandoff(d)).rejects.toThrow(/message box/);
    expect(calls).toEqual(['step passport']);
    expect(await d.artifacts.list()).toEqual([]);
    expect(await takePendingInsertItem(area)).toBeNull();
  });

  it('links source and new chat both ways, and traces a chain of handoffs', async () => {
    const h = createHandoffs(memoryArea());
    const a = await h.add({ sourceChat: 'https://claude.ai/chat/c1?x=1', targetUrl: 'https://claude.ai/project/p1' });
    expect(await h.linkNewChat(a.id, 'https://claude.ai/chat/c2#bottom')).toMatchObject({ newChat: 'https://claude.ai/chat/c2' });
    const b = await h.add({ sourceChat: 'https://claude.ai/chat/c2', targetUrl: 'https://claude.ai/project/p1' });
    await h.linkNewChat(b.id, 'https://claude.ai/chat/c3');
    expect((await h.linksFor('https://claude.ai/chat/c2')).from.id).toBe(a.id);
    expect((await h.linksFor('https://claude.ai/chat/c2')).to.map((x) => x.id)).toEqual([b.id]);
    expect(await h.chainFor('https://claude.ai/chat/c3')).toEqual(['https://claude.ai/chat/c1', 'https://claude.ai/chat/c2', 'https://claude.ai/chat/c3']);
    expect(await h.chainFor('https://claude.ai/chat/c1')).toEqual(['https://claude.ai/chat/c1', 'https://claude.ai/chat/c2', 'https://claude.ai/chat/c3']);
    // A second link attempt never overwrites the first.
    await h.linkNewChat(a.id, 'https://claude.ai/chat/zzz');
    expect((await h.linksFor('https://claude.ai/chat/c1')).to[0].newChat).toBe('https://claude.ai/chat/c2');
    expect(chatKeyOf('https://claude.ai/chat/c2/?a=1')).toBe('https://claude.ai/chat/c2');
  });
});
