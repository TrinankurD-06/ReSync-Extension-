import { describe, it, expect, beforeEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { isolateHome, makeRepo } from './helpers.js';
import { loadConfig } from '../src/config.js';
import { addTask, readQueue, removeTask, nextRunnable, recoverCrashed, patchTask, findTask } from '../src/queue/store.js';
import { ensureWorktree, commitLeftovers, assertReSyncBranch, listWorktrees } from '../src/queue/worktree.js';
import { registerRunner } from '../src/queue/runners/index.js';
import { runQueue, msUntil } from '../src/queue/run.js';
import { buildArgs, parseResult, extractTestsRun } from '../src/queue/runners/claudeCode.js';
import { readUsage } from '../src/usageLog.js';

/** Fake runner: behaviour is driven by the task text so tests stay readable. */
const seen = [];
registerRunner({
  name: 'fake',
  description: 'test runner',
  async run({ task, cwd, log }) {
    seen.push({ task, cwd });
    log(`fake running in ${cwd}\n`);
    if (task.includes('LIMIT')) {
      return { success: false, exitCode: 1, output: "You've hit your session limit · resets 3:45pm" };
    }
    if (task.includes('CRASH')) throw new Error('runner blew up');
    if (task.includes('FAIL')) return { success: false, exitCode: 2, output: 'Error: compile failed' };
    const name = task.match(/write (\S+)/)?.[1] ?? 'out.txt';
    await fs.writeFile(path.join(cwd, name), `made by ${task}\n`);
    return {
      success: true, exitCode: 0, output: 'ok',
      resultText: `Created ${name}.\nTests run: npm test (3 passed)`, testsRun: 'npm test (3 passed)',
      usage: { costUsd: 0.01, inputTokens: 100, outputTokens: 20, sessionId: `sess-${name}`, durationMs: 5 },
    };
  },
});

let repo;
beforeEach(async () => {
  await isolateHome();
  repo = await makeRepo();
  seen.length = 0;
});

const quiet = () => {};

describe('queue store', () => {
  it('adds, lists, finds by prefix and removes tasks', async () => {
    const a = await addTask({ task: 'one', repo: repo.dir, tools: ['Read'], runner: 'fake' });
    const b = await addTask({ task: 'two', repo: repo.dir, tools: ['Read'], runner: 'fake' });
    expect(a.status).toBe('pending');
    expect((await readQueue()).tasks.map((t) => t.task)).toEqual(['one', 'two']);
    expect(findTask((await readQueue()).tasks, b.id).task).toBe('two');
    await removeTask(a.id);
    expect((await readQueue()).tasks).toHaveLength(1);
    await expect(addTask({ task: '  ', repo: repo.dir, tools: [], runner: 'fake' })).rejects.toThrow(/required/);
  });

  it('respects notBefore when picking the next task', async () => {
    const a = await addTask({ task: 'later', repo: repo.dir, tools: [], runner: 'fake' });
    await patchTask(a.id, { status: 'waiting-for-reset', notBefore: new Date(Date.now() + 3600_000).toISOString() });
    const b = await addTask({ task: 'now', repo: repo.dir, tools: [], runner: 'fake' });
    expect(nextRunnable((await readQueue()).tasks).id).toBe(b.id);
    expect(nextRunnable((await readQueue()).tasks, new Date(Date.now() + 2 * 3600_000)).id).toBe(a.id);
  });

  it('marks tasks left running by a crash as failed', async () => {
    const a = await addTask({ task: 'x', repo: repo.dir, tools: [], runner: 'fake' });
    await patchTask(a.id, { status: 'running', pid: 999999 });
    expect(await recoverCrashed(() => false)).toEqual([a.id]);
    expect((await readQueue()).tasks[0]).toMatchObject({ status: 'failed' });
  });
});

describe('worktrees', () => {
  it('creates resync/<id> branches in separate worktrees and never touches main', async () => {
    const mainHead = repo.git('rev-parse', 'main');
    const w1 = await ensureWorktree(repo.dir, 't1');
    const w2 = await ensureWorktree(repo.dir, 't2');
    expect(w1.branch).toBe('resync/t1');
    expect(w1.worktree).not.toBe(w2.worktree);
    await fs.writeFile(path.join(w1.worktree, 'a.txt'), 'a');
    expect(await commitLeftovers(w1.worktree, w1.branch, 'work')).toBe(true);
    expect(repo.git('rev-parse', 'main')).toBe(mainHead);
    expect(repo.git('rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
    expect(repo.git('status', '--porcelain')).toBe('');
    expect((await ensureWorktree(repo.dir, 't1')).reused).toBe(true);
    expect((await listWorktrees(repo.dir)).map((w) => w.branch)).toEqual(['main', 'resync/t1', 'resync/t2']);
  });

  it('refuses to write to non-resync branches', () => {
    expect(() => assertReSyncBranch('main')).toThrow(/Refusing/);
  });
});

describe('queue run (definition of done)', () => {
  it('runs two queued tasks in separate worktrees, writes reports and usage, leaves main alone', async () => {
    const mainHead = repo.git('rev-parse', 'main');
    const cfg = await loadConfig();
    const t1 = await addTask({ task: 'write first.txt', repo: repo.dir, tools: ['Read', 'Edit'], runner: 'fake' });
    const t2 = await addTask({ task: 'write second.txt', repo: repo.dir, tools: ['Read', 'Edit'], runner: 'fake' });
    const lines = [];
    const summary = await runQueue({ config: cfg, out: (l) => lines.push(l) });
    expect(summary).toEqual({ done: 2, failed: 0, waiting: 0 });

    expect(seen).toHaveLength(2);
    expect(seen[0].cwd).not.toBe(seen[1].cwd);
    const q = (await readQueue()).tasks;
    expect(q.map((t) => t.status)).toEqual(['done', 'done']);
    expect(q.map((t) => t.branch)).toEqual([`resync/${t1.id}`, `resync/${t2.id}`]);

    // Each branch has only its own file; main is untouched.
    expect(repo.git('ls-tree', '--name-only', `resync/${t1.id}`)).toContain('first.txt');
    expect(repo.git('ls-tree', '--name-only', `resync/${t1.id}`)).not.toContain('second.txt');
    expect(repo.git('ls-tree', '--name-only', `resync/${t2.id}`)).toContain('second.txt');
    expect(repo.git('rev-parse', 'main')).toBe(mainHead);
    expect(repo.git('ls-tree', '--name-only', 'main')).toBe('README.md');

    const report = await fs.readFile(path.join(repo.dir, '.resync', 'queue-reports', `${t1.id}.md`), 'utf8');
    expect(report).toContain('**Result:** done');
    expect(report).toContain('`first.txt`');
    expect(report).toContain('npm test (3 passed)');
    expect(report).not.toContain('.git-resync-base');
    expect(lines.join('\n')).toMatch(/DONE: .* 1 file\(s\) changed, tests: npm test/);

    const { records } = await readUsage();
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({ source: 'queue', user: 'tester', inputTokens: 100, costUsd: 0.01, sessionId: 'sess-first.txt' });
    // The report folder is excluded locally so it can't be committed by accident.
    expect(repo.git('status', '--porcelain')).toBe('');
  });

  it('moves a task hitting a fake limit message to waiting-for-reset with the parsed reset time', async () => {
    const cfg = await loadConfig();
    const t = await addTask({ task: 'LIMIT please', repo: repo.dir, tools: ['Read'], runner: 'fake' });
    const ok = await addTask({ task: 'write fine.txt', repo: repo.dir, tools: ['Read'], runner: 'fake' });
    const now = new Date(2026, 9, 17, 14, 0);
    const summary = await runQueue({ config: cfg, out: quiet, now: () => now });
    expect(summary).toEqual({ done: 1, failed: 0, waiting: 1 });
    const q = (await readQueue()).tasks;
    const limited = q.find((x) => x.id === t.id);
    expect(limited.status).toBe('waiting-for-reset');
    expect(new Date(limited.notBefore)).toEqual(new Date(2026, 9, 17, 15, 46));
    expect(limited.lastError).toMatch(/session limit/);
    expect(q.find((x) => x.id === ok.id).status).toBe('done');
    const report = await fs.readFile(limited.reportFile, 'utf8');
    expect(report).toContain('waiting-for-reset');
    expect(report).toContain('## Retry');
  });

  it('backs off 15 min when the limit message has no reset time, doubling on repeat', async () => {
    const cfg = await loadConfig();
    registerRunner({ name: 'fake-notime', description: '', run: async () => ({ success: false, exitCode: 1, output: 'usage limit reached' }) });
    await addTask({ task: 'limited without a reset time', repo: repo.dir, tools: [], runner: 'fake-notime' });
    let now = new Date(2026, 9, 17, 14, 0);
    await runQueue({ config: cfg, out: quiet, now: () => now });
    let task = (await readQueue()).tasks[0];
    expect(task).toMatchObject({ status: 'waiting-for-reset', backoffMinutes: 15 });
    now = new Date(task.notBefore);
    await runQueue({ config: cfg, out: quiet, now: () => now });
    task = (await readQueue()).tasks[0];
    expect(task.backoffMinutes).toBe(30);
    expect(task.attempts).toBe(2);
    expect(task.worktree).toBeTruthy();
  });

  it('marks failures and runner crashes as failed, keeping the log', async () => {
    const cfg = await loadConfig();
    await addTask({ task: 'FAIL now', repo: repo.dir, tools: [], runner: 'fake' });
    await addTask({ task: 'CRASH now', repo: repo.dir, tools: [], runner: 'fake' });
    const summary = await runQueue({ config: cfg, out: quiet });
    expect(summary).toEqual({ done: 0, failed: 2, waiting: 0 });
    const q = (await readQueue()).tasks;
    expect(q[1].lastError).toBe('runner blew up');
    const log = await fs.readFile(q[1].logFile, 'utf8');
    expect(log).toContain('runner error');
  });

  it('watch mode sleeps until the reset time, then retries', async () => {
    const cfg = await loadConfig();
    let calls = 0;
    registerRunner({ name: 'flaky', description: '', run: async ({ cwd }) => {
      calls++;
      if (calls === 1) return { success: false, exitCode: 1, output: "You've hit your session limit · resets 3:45pm" };
      await fs.writeFile(path.join(cwd, 'x.txt'), 'x');
      return { success: true, exitCode: 0, output: 'ok', resultText: 'done' };
    } });
    await addTask({ task: 'flaky task', repo: repo.dir, tools: [], runner: 'flaky' });
    let now = new Date(2026, 9, 17, 14, 0);
    const ac = new AbortController();
    const sleeps = [];
    await runQueue({
      config: cfg, out: quiet, watch: true, now: () => now, signal: ac.signal,
      sleep: async (ms) => {
        sleeps.push(ms);
        now = new Date(now.getTime() + ms);
        if ((await readQueue()).tasks.every((t) => t.status === 'done')) ac.abort();
      },
    });
    expect(calls).toBe(2);
    expect((await readQueue()).tasks[0].status).toBe('done');
    expect(sleeps[0]).toBe(30_000); // capped poll interval
  });
});

describe('claude-code runner', () => {
  it('builds headless args with an allowlist and no prompts by default', () => {
    const args = buildArgs({ task: 'Fix "the" bug', tools: ['Read', 'Edit', 'Bash(npm test *)'], skipPermissions: false });
    expect(args.slice(0, 4)).toEqual(['-p', 'Fix "the" bug', '--output-format', 'json']);
    expect(args).toContain('--allowedTools');
    expect(args[args.indexOf('--allowedTools') + 1]).toBe('Read,Edit,Bash(npm test *)');
    expect(args).toContain('--permission-prompts');
    expect(args).not.toContain('--dangerously-skip-permissions');
  });
  it('uses skip-permissions only when the task opted in', () => {
    const args = buildArgs({ task: 't', tools: ['Read'], skipPermissions: true });
    expect(args).toContain('--dangerously-skip-permissions');
    expect(args).not.toContain('--allowedTools');
  });
  it('parses success and error results', () => {
    const ok = parseResult('{"type":"result","subtype":"success","is_error":false,"result":"Done.\\nTests run: npm test - 5 passed","total_cost_usd":0.02,"usage":{"input_tokens":10,"output_tokens":5},"session_id":"s1"}');
    expect(ok.result).toContain('Done.');
    expect(extractTestsRun(ok.result)).toBe('npm test - 5 passed');
    expect(extractTestsRun('- **Tests run:** none')).toBe('none');
    const err = parseResult('noise\n{"type":"result","subtype":"error_max_turns","is_error":true,"errors":["max turns"]}');
    expect(err.subtype).toBe('error_max_turns');
    expect(parseResult('not json')).toBeNull();
  });
});

describe('run --at', () => {
  it('computes the wait until the next occurrence', () => {
    const from = new Date(2026, 9, 17, 14, 0);
    expect(msUntil('02:00', from)).toBe(12 * 3600_000);
    expect(msUntil('14:30', from)).toBe(30 * 60_000);
    expect(msUntil('2:30pm', from)).toBe(30 * 60_000);
    expect(() => msUntil('25:00', from)).toThrow();
    expect(() => msUntil('soon', from)).toThrow();
  });
});
