// Plugin hooks with sample stdin (shapes copied from docs/VERIFIED.md, "Hooks").
import { describe, it, expect, beforeEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { preCompact, sessionStart, sessionEnd } from '../scripts/hook.mjs';
import { processPending, transcriptTotals, delta } from '../scripts/usage-worker.mjs';
import { validateUsageRecord } from '../../shared/src/usage.js';

const HOOK = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../scripts/hook.mjs');
let home;

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'resync-plugin-'));
  process.env.RESYNC_HOME = home;
  process.env.RESYNC_USER = 'tester';
});

const PRECOMPACT = { session_id: 'abc123', transcript_path: '/tmp/t.jsonl', cwd: '/work/resync', hook_event_name: 'PreCompact', trigger: 'auto', custom_instructions: null };
const SESSIONSTART = { session_id: 'abc123', transcript_path: '/tmp/t.jsonl', cwd: '/work/resync', hook_event_name: 'SessionStart', source: 'compact' };

const readUsage = async () => (await fs.readFile(path.join(home, 'usage.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));

describe('PreCompact + SessionStart(compact): passport reminder without any AI call', () => {
  it('saves a marker, then injects the reminder once after compaction', async () => {
    expect(await preCompact(PRECOMPACT)).toBeNull();
    const marker = JSON.parse(await fs.readFile(path.join(home, 'compact-markers', 'abc123.json'), 'utf8'));
    expect(marker).toMatchObject({ sessionId: 'abc123', transcriptPath: '/tmp/t.jsonl', trigger: 'auto', reminded: false });

    const out = await sessionStart(SESSIONSTART);
    expect(out.hookSpecificOutput.hookEventName).toBe('SessionStart');
    expect(out.hookSpecificOutput.additionalContext).toMatch(/\/resync:passport/);
    // Only once per compaction.
    expect(await sessionStart(SESSIONSTART)).toBeNull();
  });

  it('ignores other session starts and stale markers', async () => {
    await preCompact(PRECOMPACT);
    expect(await sessionStart({ ...SESSIONSTART, source: 'startup' })).toBeNull();
    const f = path.join(home, 'compact-markers', 'abc123.json');
    const m = JSON.parse(await fs.readFile(f, 'utf8'));
    await fs.writeFile(f, JSON.stringify({ ...m, time: new Date(Date.now() - 3600_000).toISOString() }));
    expect(await sessionStart(SESSIONSTART)).toBeNull();
  });

  it('falls back to the newest recent marker if the session id changed', async () => {
    await preCompact(PRECOMPACT);
    const out = await sessionStart({ ...SESSIONSTART, session_id: 'new-id' });
    expect(out?.hookSpecificOutput.additionalContext).toMatch(/compacted \(auto trigger\)/);
  });

  it('works as a real process with JSON on stdin and prints valid hook JSON', () => {
    const env = { ...process.env, RESYNC_HOME: home };
    const a = spawnSync(process.execPath, [HOOK, 'pre-compact'], { input: JSON.stringify(PRECOMPACT), env });
    expect(a.status).toBe(0);
    expect(a.stdout.toString()).toBe('');
    const b = spawnSync(process.execPath, [HOOK, 'session-start'], { input: JSON.stringify(SESSIONSTART), env });
    expect(b.status).toBe(0);
    expect(JSON.parse(b.stdout.toString()).hookSpecificOutput.additionalContext).toContain('/resync:passport');
    const c = spawnSync(process.execPath, [HOOK, 'nope'], { input: '{}', env });
    expect(c.status).toBe(1);
  });
});

const line = (o) => JSON.stringify(o);
const TRANSCRIPT = [
  line({ type: 'user', message: { role: 'user', content: 'Fix the bug' } }),
  line({ type: 'assistant', message: { id: 'm1', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'Looking' }], usage: { input_tokens: 10, output_tokens: 2 } } }),
  // Same message logged again while streaming: counted once (last wins).
  line({ type: 'assistant', message: { id: 'm1', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'Looking...' }], usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100 } } }),
  line({ type: 'assistant', message: { id: 'm2', role: 'assistant', content: [{ type: 'text', text: 'Done' }], usage: { input_tokens: 20, output_tokens: 7, cache_creation_input_tokens: 50 } } }),
  line({ type: 'assistant', isSidechain: true, message: { id: 's1', role: 'assistant', usage: { input_tokens: 999 } } }),
  'not json',
].join('\n');

describe('SessionEnd: usage record (numbers only)', () => {
  it('sums transcript usage per message id, skipping sidechains', () => {
    expect(transcriptTotals(TRANSCRIPT)).toEqual({ inputTokens: 30, outputTokens: 12, cacheReadTokens: 100, cacheCreationTokens: 50, estimatedTokens: undefined, messages: 1, model: 'claude-opus-5-5' });
    expect(transcriptTotals(line({ type: 'user', message: { role: 'user', content: 'x'.repeat(400) } })).estimatedTokens).toBe(100);
  });

  it('appends one valid record using the statusline snapshot for cost, then only deltas on resume', async () => {
    const transcript = path.join(home, 't.jsonl');
    await fs.writeFile(transcript, TRANSCRIPT);
    await fs.mkdir(path.join(home, 'sessions'), { recursive: true });
    await fs.writeFile(path.join(home, 'sessions', 'abc123.json'), JSON.stringify({ costUsd: 0.25, durationMs: 60000, model: 'Opus', project: 'resync' }));

    let spawned = null;
    await sessionEnd({ session_id: 'abc123', transcript_path: transcript, cwd: '/work/resync', hook_event_name: 'SessionEnd', reason: 'prompt_input_exit' }, { spawnWorker: (f) => (spawned = f) });
    expect(spawned).toMatch(/pending/);
    const rec = await processPending(spawned);
    expect(validateUsageRecord(rec).ok).toBe(true);
    expect(rec).toMatchObject({ user: 'tester', project: 'resync', sessionId: 'abc123', source: 'plugin', model: 'Opus', inputTokens: 30, costUsd: 0.25, isEstimate: true });
    await expect(fs.access(spawned)).rejects.toThrow();

    // Resumed later: transcript grows, cost grows. Only the increase is recorded.
    await fs.appendFile(transcript, '\n' + line({ type: 'assistant', message: { id: 'm3', role: 'assistant', usage: { input_tokens: 5, output_tokens: 1 } } }));
    await fs.writeFile(path.join(home, 'sessions', 'abc123.json'), JSON.stringify({ costUsd: 0.3, model: 'Opus', project: 'resync' }));
    await sessionEnd({ session_id: 'abc123', transcript_path: transcript, cwd: '/work/resync' }, { spawnWorker: (f) => (spawned = f) });
    const rec2 = await processPending(spawned);
    expect(rec2).toMatchObject({ inputTokens: 5, outputTokens: 1, costUsd: 0.05 });
    expect(rec2).not.toHaveProperty('cacheReadTokens');

    // Nothing new: nothing appended.
    await sessionEnd({ session_id: 'abc123', transcript_path: transcript, cwd: '/work/resync' }, { spawnWorker: (f) => (spawned = f) });
    expect(await processPending(spawned)).toBeNull();
    expect(await readUsage()).toHaveLength(2);
  });

  it('records nothing (and cleans up) when there are no numbers: no snapshot, unreadable transcript', async () => {
    await sessionEnd({ session_id: 'zz', transcript_path: path.join(home, 'missing.jsonl'), cwd: '/work/site' }, { spawnWorker: () => {} });
    const pending = path.join(home, 'pending', (await fs.readdir(path.join(home, 'pending')))[0]);
    const rec = await processPending(pending);
    expect(rec).toBeNull();
    expect(await fs.readdir(path.join(home, 'pending'))).toEqual([]);
  });

  it('the real hook process returns at once and the detached worker writes the record', async () => {
    const transcript = path.join(home, 't.jsonl');
    await fs.writeFile(transcript, TRANSCRIPT);
    const started = Date.now();
    const r = spawnSync(process.execPath, [HOOK, 'session-end'], { input: JSON.stringify({ session_id: 'live1', transcript_path: transcript, cwd: '/work/resync', hook_event_name: 'SessionEnd', reason: 'other' }), env: { ...process.env, RESYNC_HOME: home } });
    expect(r.status).toBe(0);
    expect(Date.now() - started).toBeLessThan(1500);
    let recs = [];
    for (let i = 0; i < 50 && !recs.length; i++) {
      await new Promise((res) => setTimeout(res, 100));
      recs = await readUsage().catch(() => []);
    }
    expect(recs[0]).toMatchObject({ sessionId: 'live1', inputTokens: 30 });
  });

  it('delta ignores non-numbers and non-increases', () => {
    expect(delta({ a: 5, b: 2, c: undefined }, { a: 3, b: 2 })).toEqual({ a: 2 });
  });
});
