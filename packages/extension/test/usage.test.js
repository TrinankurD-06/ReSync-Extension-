import { describe, it, expect, beforeEach } from 'vitest';
import {
  createUsageStore, toUsageRecords, summarise, defaultUsageModel, normaliseUsageModel, projectFileTokens, capacityToTokens,
  createChatEstimator, estimateChat,
} from '../src/lib/usageEstimates.js';
import { createUsageTracker, countAttachments, detectProjectKnowledge } from '../src/content/usageTracker.js';
import { validateUsageRecord } from '@resync/shared/usage';
import { memoryArea } from './fakeChrome.js';

beforeEach(() => {
  document.body.innerHTML = '';
});

/** A model with round numbers so the arithmetic is easy to follow. */
const MODEL = normaliseUsageModel({
  imageTokens: { low: 1000, high: 1500 },
  fileTokens: { low: 500, high: 5000 },
  hiddenTokens: { low: 2000, high: 20000 },
  projectDefault: { low: 0, high: 10000 },
});

describe('usage store and sync records', () => {
  it('adds typed tokens and the processed range per day and project; records carry both, numbers only', async () => {
    const u = createUsageStore(memoryArea());
    const day = new Date(2026, 9, 17);
    await u.add({ project: 'Launch', messages: 1, typedTokens: 10, processed: { low: 2010, high: 20010 }, date: day });
    await u.add({ project: 'Launch', processed: { low: 40, high: 40 }, date: day });
    await u.add({ project: '', messages: 1, typedTokens: 5, processed: { low: 5, high: 5 }, date: day });
    const rows = await u.all();
    expect(rows).toContainEqual({ date: '2026-10-17', project: 'Launch', messages: 1, typedTokens: 10, processedLow: 2050, processedHigh: 20050 });
    expect(rows).toContainEqual({ date: '2026-10-17', project: 'No project', messages: 1, typedTokens: 5, processedLow: 5, processedHigh: 5 });
    const recs = toUsageRecords(rows, 'alice');
    for (const r of recs) {
      expect(validateUsageRecord(r).ok).toBe(true);
      expect(r).toMatchObject({ source: 'extension', isEstimate: true });
    }
    expect(recs.find((r) => r.project === 'Launch')).toMatchObject({ estimatedTokens: 10, processedTokensLow: 2050, processedTokensHigh: 20050 });
    expect(JSON.stringify(recs)).not.toMatch(/content|text/);
  });

  it('reads rows saved before the split (one estimatedTokens figure) as typed tokens', async () => {
    const area = memoryArea();
    await area.set({ 'resync.usage': { 'x': { date: '2026-10-17', project: 'A', messages: 2, estimatedTokens: 70 } } });
    expect(await createUsageStore(area).all()).toEqual([{ date: '2026-10-17', project: 'A', messages: 2, typedTokens: 70, processedLow: 0, processedHigh: 0 }]);
  });

  it('summarises 7 days (zero-filled), the week and projects', () => {
    const rows = [
      { date: '2026-10-17', project: 'A', messages: 2, typedTokens: 100, processedLow: 4000, processedHigh: 30000 },
      { date: '2026-10-15', project: 'B', messages: 1, typedTokens: 300, processedLow: 9000, processedHigh: 50000 },
      { date: '2026-10-01', project: 'C', messages: 9, typedTokens: 999, processedLow: 1, processedHigh: 1 },
    ];
    const s = summarise(rows, { today: new Date(2026, 9, 17) });
    expect(s.days).toHaveLength(7);
    expect(s.days[6]).toEqual({ date: '2026-10-17', messages: 2, typed: 100, processed: { low: 4000, high: 30000 } });
    expect(s.days[4].processed).toEqual({ low: 9000, high: 50000 });
    expect(s.week).toEqual({ messages: 3, typed: 400, processed: { low: 13000, high: 80000 } });
    expect(s.projects.map((p) => p.project)).toEqual(['B', 'A']);
  });
});

describe('estimated tokens processed', () => {
  it('re-reads all earlier turns on every message (cumulative context), and counts each reply once', () => {
    // Three exchanges of 100-token messages and 300-token replies, no attachments, no project.
    const turns = [
      { role: 'user', tokens: 100 }, { role: 'assistant', tokens: 300 },
      { role: 'user', tokens: 100 }, { role: 'assistant', tokens: 300 },
      { role: 'user', tokens: 100 }, { role: 'assistant', tokens: 300 },
    ];
    const r = estimateChat(/** @type {any} */ (turns), { model: MODEL, project: { low: 0, high: 0 } });
    expect(r.typed).toBe(300);
    // Inputs: 100, 400+100, 800+100 = 1500; + hidden 3 x 2000..20000; + replies 900.
    expect(r.rows[0].parts.earlierTurns).toEqual({ low: 0, high: 0 });
    expect(r.rows[2].parts.earlierTurns).toEqual({ low: 400, high: 400 });
    expect(r.rows[4].parts.earlierTurns).toEqual({ low: 800, high: 800 });
    expect(r.processed).toEqual({ low: 1500 + 6000 + 900, high: 1500 + 60000 + 900 });
    // The typed figure is tiny next to what is processed.
    expect(r.processed.low / r.typed).toBeGreaterThan(10);
  });

  it('adds attachments (re-read in later turns too), project files and the hidden allowance as a range', () => {
    const est = createChatEstimator({ model: MODEL, project: { low: 8000, high: 12000 } });
    const first = est.user({ tokens: 50, images: 1, files: 1 });
    expect(first.parts).toEqual({
      earlierTurns: { low: 0, high: 0 },
      message: { low: 50, high: 50 },
      attachments: { low: 1500, high: 6500 },
      projectFiles: { low: 8000, high: 12000 },
      hidden: { low: 2000, high: 20000 },
    });
    expect(first.processed).toEqual({ low: 11550, high: 38550 });
    est.reply({ tokens: 400 });
    const second = est.user({ tokens: 20 });
    expect(second.parts.earlierTurns).toEqual({ low: 50 + 1500 + 400, high: 50 + 6500 + 400 });
  });

  it('project files: detected on the project page, else entered in Settings, else the default', () => {
    const model = normaliseUsageModel({ ...MODEL, projectFiles: { Launch: 7000, Other: 3000 } });
    const detected = { Launch: { low: 9000, high: 11000 } };
    expect(projectFileTokens('Launch', { detected, model })).toEqual({ low: 9000, high: 11000, source: 'detected' });
    expect(projectFileTokens('Other', { detected, model })).toEqual({ low: 3000, high: 3000, source: 'settings' });
    expect(projectFileTokens('New', { detected, model })).toEqual({ low: 0, high: 10000, source: 'default' });
    expect(projectFileTokens('No project', { detected, model })).toEqual({ low: 0, high: 0, source: 'none' });
    // "5% of project capacity used" with a 200k capacity: 4.5% to 5.5%.
    expect(capacityToTokens(5, 200_000)).toEqual({ low: 9000, high: 11000 });
  });

  it('cleans bad settings back to defaults', () => {
    const m = normaliseUsageModel({ imageTokens: { low: 'x', high: 900 }, hiddenTokens: { low: 9, high: 3 }, projectFiles: { '': 5, A: -1, B: '40' } });
    expect(m.imageTokens).toEqual({ low: defaultUsageModel().imageTokens.low, high: 900 });
    expect(m.hiddenTokens).toEqual({ low: 3, high: 9 });
    expect(m.projectFiles).toEqual({ B: 40 });
  });
});

describe('usage tracker on the page', () => {
  it('ignores history as usage but re-reads it as context; counts typed tokens and the processed range', async () => {
    document.body.innerHTML = '<main id="t"><div data-testid="user-message">' + 'q'.repeat(400) + '</div><div class="font-claude-response">' + 'a'.repeat(800) + '</div></main>';
    const events = [];
    const tracker = createUsageTracker({ add: async (e) => events.push(e), getOverrides: () => ({}), getModel: () => MODEL, projectName: () => 'No project', chatId: () => '' });
    await tracker.baseline();
    await tracker.scan();
    expect(events).toEqual([]);

    const t = document.getElementById('t');
    t.insertAdjacentHTML('beforeend', '<div data-testid="user-message">' + 'x'.repeat(40) + '</div>');
    t.insertAdjacentHTML('beforeend', '<div class="font-claude-response" data-is-streaming="true">partial</div>');
    await tracker.scan();
    // typed: 40 chars / 4 = 10. processed: history (100 + 200) + 10 + hidden 2000..20000.
    expect(events).toEqual([{ project: 'No project', messages: 1, typedTokens: 10, processed: { low: 2310, high: 20310 } }]);

    const reply = t.lastElementChild;
    reply.dataset.isStreaming = 'false';
    reply.textContent = 'y'.repeat(80);
    await tracker.scan();
    expect(events[1]).toEqual({ project: 'No project', processed: { low: 20, high: 20 } });
    await tracker.scan();
    expect(events).toHaveLength(2);
  });

  it('keeps a chat\'s context across reloads (saved as numbers only)', async () => {
    const area = memoryArea();
    const store = createUsageStore(area);
    await store.saveChatContext('c1', { low: 5000, high: 9000 });
    document.body.innerHTML = '<main id="t"><div data-testid="user-message">short</div></main>';
    const events = [];
    const tracker = createUsageTracker({ add: async (e) => events.push(e), getOverrides: () => ({}), getModel: () => MODEL, memory: store, projectName: () => 'No project', chatId: () => 'c1' });
    await tracker.baseline();
    document.getElementById('t').insertAdjacentHTML('beforeend', '<div data-testid="user-message">' + 'x'.repeat(40) + '</div>');
    await tracker.scan();
    expect(events[0].processed).toEqual({ low: 5000 + 10 + 2000, high: 9000 + 10 + 20000 });
    expect(await store.chatContext('c1')).toMatchObject({ low: 5010, high: 9010 });
  });

  it('counts attachments inside the message\'s turn', () => {
    document.body.innerHTML = `<div data-test-render-count="1"><div data-testid="file-thumbnail"><img src="x.png"></div><div data-testid="file-thumbnail">notes.pdf</div><div data-testid="user-message" id="m">see these</div></div>
      <div data-test-render-count="2"><div data-testid="file-thumbnail"><img src="y.png"></div></div>`;
    expect(countAttachments(document.getElementById('m'), {})).toEqual({ images: 1, files: 1 });
  });

  it('reads "N% of project capacity used" on a project page', () => {
    document.body.innerHTML = '<main><h1>Launch</h1><div data-testid="project-knowledge">Project knowledge · 5% of project capacity used</div></main>';
    expect(detectProjectKnowledge({ pathname: '/project/abc', capacityTokens: 200_000 })).toEqual({ project: 'Launch', percent: 5, tokens: { low: 9000, high: 11000 } });
    expect(detectProjectKnowledge({ pathname: '/chat/abc', capacityTokens: 200_000 })).toBeNull();
  });

  it('does not count messages the virtual transcript re-adds or loads from history', async () => {
    const msg = (role, key, text) => role === 'u'
      ? `<div data-testid="user-message" data-turn-key="${key}">${text}</div>`
      : `<div data-testid="assistant-message" data-turn-key="${key}" data-is-streaming="false">${text}</div>`;
    document.body.innerHTML = `<main id="t">${msg('u', 'u2', 'q2')}${msg('a', 'a2', 'r2')}</main>`;
    const events = [];
    const tracker = createUsageTracker({ add: async (e) => events.push(e), getOverrides: () => ({}), projectName: () => 'P', chatId: () => '' });
    await tracker.baseline();
    const t = document.getElementById('t');
    // "Load earlier messages": older turns appear above the ones already on the page.
    t.insertAdjacentHTML('afterbegin', msg('u', 'u1', 'q1') + msg('a', 'a1', 'r1'));
    await tracker.scan();
    // Scrolling: the newest turns are removed and added back as new elements.
    t.innerHTML = msg('u', 'u2', 'q2') + msg('a', 'a2', 'r2');
    await tracker.scan();
    expect(events).toEqual([]);
    t.insertAdjacentHTML('beforeend', msg('u', 'u3', 'q3') + msg('a', 'a3', 'r3'));
    await tracker.scan();
    expect(events.map((e) => e.messages ?? 'reply')).toEqual([1, 'reply']);
  });
});
