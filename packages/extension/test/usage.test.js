import { describe, it, expect, beforeEach } from 'vitest';
import { createUsageStore, toUsageRecords, summarise } from '../src/lib/usageEstimates.js';
import { createUsageTracker } from '../src/content/usageTracker.js';
import { validateUsageRecord } from '@resync/shared/usage';
import { memoryArea } from './fakeChrome.js';

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('usage estimates', () => {
  it('adds per day and project, and converts to valid numbers-only records', async () => {
    const u = createUsageStore(memoryArea());
    const day = new Date(2026, 9, 17);
    await u.add({ project: 'Launch', messages: 1, tokens: 10, date: day });
    await u.add({ project: 'Launch', tokens: 40, date: day });
    await u.add({ project: '', messages: 1, tokens: 5, date: day });
    const rows = await u.all();
    expect(rows).toContainEqual({ date: '2026-10-17', project: 'Launch', messages: 1, estimatedTokens: 50 });
    expect(rows).toContainEqual({ date: '2026-10-17', project: 'No project', messages: 1, estimatedTokens: 5 });
    for (const r of toUsageRecords(rows, 'alice')) {
      expect(validateUsageRecord(r).ok).toBe(true);
      expect(r).toMatchObject({ source: 'extension', isEstimate: true });
    }
  });

  it('summarises 7 days (zero-filled) and projects', () => {
    const rows = [
      { date: '2026-10-17', project: 'A', messages: 2, estimatedTokens: 100 },
      { date: '2026-10-15', project: 'B', messages: 1, estimatedTokens: 300 },
      { date: '2026-10-01', project: 'C', messages: 9, estimatedTokens: 999 },
    ];
    const s = summarise(rows, { today: new Date(2026, 9, 17) });
    expect(s.days).toHaveLength(7);
    expect(s.days[6]).toEqual({ date: '2026-10-17', messages: 2, tokens: 100 });
    expect(s.days[4].tokens).toBe(300);
    expect(s.projects.map((p) => p.project)).toEqual(['B', 'A']);
  });

  it('tracker ignores history, counts new user messages and finished replies', async () => {
    document.body.innerHTML = '<main id="t"><div data-testid="user-message">old question</div><div class="font-claude-response">old answer</div></main>';
    const events = [];
    const tracker = createUsageTracker({ add: async (e) => events.push(e), getOverrides: () => ({}), projectName: () => 'Launch' });
    tracker.baseline();
    await tracker.scan();
    expect(events).toEqual([]);

    const t = document.getElementById('t');
    t.insertAdjacentHTML('beforeend', '<div data-testid="user-message">' + 'x'.repeat(40) + '</div>');
    t.insertAdjacentHTML('beforeend', '<div class="font-claude-response" data-is-streaming="true">partial</div>');
    await tracker.scan();
    expect(events).toEqual([{ project: 'Launch', messages: 1, tokens: 10 }]); // reply still streaming

    const reply = t.lastElementChild;
    reply.dataset.isStreaming = 'false';
    reply.textContent = 'y'.repeat(80);
    await tracker.scan();
    expect(events[1]).toEqual({ project: 'Launch', tokens: 20 });
    await tracker.scan();
    expect(events).toHaveLength(2);
  });
});
