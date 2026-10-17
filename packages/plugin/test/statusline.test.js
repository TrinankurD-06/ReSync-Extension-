// Statusline with input shaped like the documented example (docs/VERIFIED.md, "Statusline").
import { describe, it, expect, beforeEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { render, short, money } from '../scripts/statusline.mjs';

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../scripts/statusline.mjs');
const NOW = new Date(2026, 9, 17, 12, 0);
let home;

const INPUT = {
  cwd: '/work/resync',
  session_id: 'abc123',
  transcript_path: '/path/to/transcript.jsonl',
  model: { id: 'claude-opus-5-5', display_name: 'Opus' },
  workspace: { current_dir: '/work/resync', project_dir: '/work/resync', added_dirs: [] },
  version: '2.1.90',
  cost: { total_cost_usd: 0.4, total_duration_ms: 45000, total_api_duration_ms: 2300, total_lines_added: 156, total_lines_removed: 23 },
  context_window: { total_input_tokens: 15500, total_output_tokens: 1200, context_window_size: 200000, used_percentage: 8, remaining_percentage: 92, current_usage: null },
  exceeds_200k_tokens: false,
};

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'resync-sl-'));
  process.env.RESYNC_HOME = home;
});

const rec = (o) => JSON.stringify({ user: 'u', project: 'p', sessionId: 's', date: '2026-10-17', source: 'plugin', isEstimate: true, ...o });

describe('statusline', () => {
  it("shows model, context, session cost and today's total, labelled as estimates", async () => {
    await fs.writeFile(path.join(home, 'usage.jsonl'), [rec({ sessionId: 'old', inputTokens: 100000, outputTokens: 20000, costUsd: 1.1 }), rec({ date: '2026-10-16', costUsd: 9 })].join('\n') + '\n');
    const line = await render(INPUT, { now: NOW });
    expect(line).toBe('Opus | ctx 17k (8%) | session $0.40 | today $1.50 120k tok (est.)');
  });

  it('writes the session snapshot used by the SessionEnd worker', async () => {
    await render(INPUT, { now: NOW });
    const snap = JSON.parse(await fs.readFile(path.join(home, 'sessions', 'abc123.json'), 'utf8'));
    expect(snap).toMatchObject({ costUsd: 0.4, durationMs: 45000, model: 'Opus', project: 'resync', projectDir: '/work/resync' });
  });

  it("does not double count this session's cost once it has been recorded", async () => {
    await fs.writeFile(path.join(home, 'usage.jsonl'), rec({ sessionId: 'abc123', costUsd: 0.3 }) + '\n');
    await fs.mkdir(path.join(home, 'sessions'), { recursive: true });
    await fs.writeFile(path.join(home, 'sessions', 'abc123.recorded.json'), JSON.stringify({ costUsd: 0.3 }));
    expect(await render(INPUT, { now: NOW })).toContain('today $0.40');
  });

  it('copes with missing or null fields early in a session', async () => {
    expect(await render({ model: { display_name: 'Sonnet' }, context_window: { current_usage: null, used_percentage: null } }, { now: NOW }))
      .toBe('Sonnet | ctx 0 | session $0 | today $0 (est.)');
    expect(await render(null, { now: NOW })).toBe('Claude | ctx 0 | session $0 | today $0 (est.)');
  });

  it('runs as a process and prints one line', () => {
    const r = spawnSync(process.execPath, [SCRIPT], { input: JSON.stringify(INPUT), env: { ...process.env, RESYNC_HOME: home } });
    expect(r.status).toBe(0);
    expect(r.stdout.toString()).toMatch(/^Opus \| ctx 17k \(8%\) \| session \$0\.40 \| today \$0\.40 \(est\.\)\n$/);
  });

  it('formats numbers compactly', () => {
    expect([short(0), short(950), short(1500), short(2_500_000)]).toEqual(['0', '950', '2k', '2.5M']);
    expect([money(undefined), money(0.456), money(12.34)]).toEqual(['$0', '$0.46', '$12.3']);
  });
});
