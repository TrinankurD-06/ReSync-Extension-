// The Limit-Aware Work Queue loop: one task at a time, each in its own worktree and branch.
import { promises as fs, createWriteStream } from 'node:fs';
import path from 'node:path';
import { localDate } from '@resync/shared/usage';
import { paths } from '../config.js';
import { readQueue, patchTask, nextRunnable, recoverCrashed } from './store.js';
import { compilePatterns, detectLimit, scheduleRetry } from './limits.js';
import { ensureWorktree, commitLeftovers, changedFiles, excludeLocally, repoRoot } from './worktree.js';
import { getRunner } from './runners/index.js';
import { renderReport, writeReport } from './report.js';
import { appendUsage } from '../usageLog.js';

/**
 * @typedef {{
 *   config: import('../config.js').ReSyncConfig,
 *   out?: (line: string) => void,           terminal output
 *   now?: () => Date,
 *   signal?: AbortSignal,
 *   resolvePrompt?: (slug: string) => Promise<string>,   saved prompt text for --prompt
 *   onReport?: (report: object) => Promise<void>,         optional upload (resync sync / config queue.uploadReports)
 * }} RunOptions
 */

/**
 * Run one task to completion (or to waiting-for-reset / failed).
 * @param {import('./store.js').QueueTask} task
 * @param {RunOptions} o
 */
export async function runTask(task, o) {
  const out = o.out ?? console.log;
  const now = o.now ?? (() => new Date());
  const startedAt = now();
  await fs.mkdir(paths.logs(), { recursive: true });
  const logFile = path.join(paths.logs(), `${task.id}.log`);
  const logStream = createWriteStream(logFile, { flags: 'a' });
  const log = (s) => logStream.write(s);
  log(`\n=== ${startedAt.toISOString()} attempt ${task.attempts + 1} ===\n`);

  await patchTask(task.id, { status: 'running', attempts: task.attempts + 1, logFile, pid: process.pid, lastError: undefined });
  out(`> Running ${task.id}: ${task.task}`);
  if (task.skipPermissions) {
    out('  WARNING: this task was queued with --skip-permissions. Claude Code may run ANY tool without asking, inside its worktree.');
  }

  let wt;
  /** @type {import('./runners/index.js').RunResult | undefined} */
  let result;
  let crash;
  try {
    wt = await ensureWorktree(task.repo, task.id);
    await patchTask(task.id, { branch: wt.branch, worktree: wt.worktree });
    out(`  worktree ${wt.worktree} on branch ${wt.branch}`);
    const promptText = task.prompt && o.resolvePrompt ? await o.resolvePrompt(task.prompt) : '';
    const instruction = promptText ? `${promptText.trim()}\n\nTask: ${task.task}` : task.task;
    const runner = getRunner(task.runner);
    result = await runner.run({
      task: instruction,
      cwd: wt.worktree,
      tools: task.tools,
      skipPermissions: task.skipPermissions,
      timeoutMs: (o.config.queue.taskTimeoutMinutes ?? 120) * 60_000,
      log,
      signal: o.signal,
      config: o.config,
    });
  } catch (e) {
    crash = /** @type {Error} */ (e);
    log(`\n[resync] runner error: ${crash.stack ?? crash.message}\n`);
  }

  const finishedAt = now();
  /** @type {'done' | 'failed' | 'waiting-for-reset'} */
  let outcome;
  let retry;
  let error;
  if (crash) {
    outcome = 'failed';
    error = crash.message;
  } else if (result?.success) {
    outcome = 'done';
  } else {
    const { patterns } = compilePatterns(o.config.queue.limitPatterns);
    const limit = detectLimit(result?.output ?? '', patterns);
    if (limit.limited) {
      outcome = 'waiting-for-reset';
      retry = scheduleRetry(result?.output ?? '', task, o.config.queue.backoff, finishedAt);
      error = `Usage limit: ${limit.line}`;
    } else {
      outcome = 'failed';
      error = `Runner exited with code ${result?.exitCode ?? '?'}${result?.resultText ? '' : ' and no result'}`;
    }
  }

  // Keep the work: commit leftovers on the task's own resync/* branch (never main, never pushed).
  let filesChanged = [];
  if (wt) {
    try {
      await commitLeftovers(wt.worktree, wt.branch, `resync queue: ${task.task.slice(0, 60)}${outcome === 'done' ? '' : ` (${outcome})`}`);
    } catch (e) {
      log(`\n[resync] could not commit leftovers: ${/** @type {Error} */ (e).message}\n`);
    }
    filesChanged = await changedFiles(wt.worktree, wt.baseCommit).catch(() => []);
    filesChanged = filesChanged.filter((f) => f !== '.git-resync-base');
  }

  const root = wt?.root ?? (await repoRoot(task.repo).catch(() => task.repo));
  const reportMd = renderReport({
    task, outcome, branch: wt?.branch, worktree: wt?.worktree, filesChanged,
    testsRun: result?.testsRun, resultText: result?.resultText, error, retry, usage: result?.usage, startedAt, finishedAt, logFile,
  });
  const reportFile = await writeReport(root, task.id, reportMd);
  await excludeLocally(root, ['.resync/']).catch(() => {});

  await patchTask(task.id, {
    status: outcome,
    pid: undefined,
    lastError: error,
    reportFile,
    notBefore: retry?.notBefore.toISOString(),
    backoffMinutes: retry ? retry.backoffMinutes : task.backoffMinutes,
    result: result?.usage,
  });

  if (result?.usage) {
    await appendUsage({
      user: o.config.user,
      project: path.basename(root),
      sessionId: result.usage.sessionId ?? `queue-${task.id}-${task.attempts + 1}`,
      date: localDate(finishedAt),
      source: 'queue',
      ...(result.usage.model ? { model: result.usage.model } : {}),
      ...pickNumbers(result.usage),
    }).catch((e) => log(`\n[resync] usage record skipped: ${e.message}\n`));
  }

  await new Promise((r) => logStream.end(r));

  // Terminal summary.
  const mark = outcome === 'done' ? 'DONE' : outcome === 'failed' ? 'FAILED' : 'WAITING';
  out(`  ${mark}: ${task.id} in ${Math.round((finishedAt.getTime() - startedAt.getTime()) / 1000)} s, ${filesChanged.length} file(s) changed${result?.testsRun ? `, tests: ${result.testsRun}` : ''}`);
  if (retry) out(`  ${retry.reason}; will retry after ${retry.notBefore.toLocaleString()}`);
  if (outcome === 'failed') out(`  ${error}. Log: ${logFile}`);
  out(`  report: ${reportFile}`);

  if (o.onReport && outcome !== 'waiting-for-reset') {
    await o
      .onReport({ taskId: task.id, title: task.task.slice(0, 200), status: outcome, summary: (result?.resultText ?? error ?? '').slice(0, 4000), branch: wt?.branch, filesChanged, testsRun: result?.testsRun, startedAt: startedAt.toISOString(), finishedAt: finishedAt.toISOString() })
      .catch((e) => out(`  (report upload skipped: ${e.message})`));
  }
  return { outcome, reportFile, filesChanged, retry };
}

/** @param {Record<string, unknown>} u */
function pickNumbers(u) {
  const keys = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheCreationTokens', 'costUsd', 'durationMs'];
  return Object.fromEntries(keys.filter((k) => typeof u[k] === 'number').map((k) => [k, u[k]]));
}

/**
 * Drain the queue: run every task that can run now, one at a time. With `watch`, keep going:
 * sleep until the next reset time or until new tasks arrive.
 * @param {RunOptions & { watch?: boolean, pollMs?: number, sleep?: (ms: number, signal?: AbortSignal) => Promise<void> }} o
 */
export async function runQueue(o) {
  const out = o.out ?? console.log;
  const now = o.now ?? (() => new Date());
  const sleep = o.sleep ?? sleepMs;
  const recovered = await recoverCrashed();
  for (const id of recovered) out(`! ${id} was left running by a previous crash; marked failed (see its log).`);

  const summary = { done: 0, failed: 0, waiting: 0 };
  while (!o.signal?.aborted) {
    const q = await readQueue();
    const next = nextRunnable(q.tasks, now());
    if (next) {
      const r = await runTask(next, o);
      if (r.outcome === 'done') summary.done++;
      else if (r.outcome === 'failed') summary.failed++;
      else summary.waiting++;
      continue;
    }
    if (!o.watch) break;
    const waiting = q.tasks.filter((t) => t.status === 'waiting-for-reset' && t.notBefore).map((t) => new Date(/** @type {string} */ (t.notBefore)).getTime());
    const pollMs = o.pollMs ?? 30_000;
    const untilReset = waiting.length ? Math.max(1000, Math.min(...waiting) - now().getTime()) : Infinity;
    const wait = Math.min(pollMs, untilReset);
    await sleep(wait, o.signal);
  }
  return summary;
}

/**
 * Milliseconds until the next local occurrence of "HH:MM" (24h) or "h:mm am/pm".
 * @param {string} at
 * @param {Date} [from]
 */
export function msUntil(at, from = new Date()) {
  const m = /^\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*$/i.exec(at);
  if (!m) throw new Error(`Could not read time "${at}". Use 24h "02:00" or "2:30am".`);
  let h = Number(m[1]);
  const min = Number(m[2] ?? 0);
  if (m[3]) {
    if (h < 1 || h > 12) throw new Error(`Invalid hour in "${at}".`);
    h = (h % 12) + (m[3].toLowerCase() === 'pm' ? 12 : 0);
  }
  if (h > 23 || min > 59) throw new Error(`Invalid time "${at}".`);
  const t = new Date(from);
  t.setHours(h, min, 0, 0);
  if (t <= from) t.setDate(t.getDate() + 1);
  return t.getTime() - from.getTime();
}

/** @param {number} ms @param {AbortSignal} [signal] */
export function sleepMs(ms, signal) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      resolve();
    }, { once: true });
  });
}
