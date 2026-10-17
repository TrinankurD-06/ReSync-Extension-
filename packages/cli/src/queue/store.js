// Work queue store: ~/.resync/queue.json. One writer at a time, atomic writes.
import { promises as fs } from 'node:fs';
import crypto from 'node:crypto';
import { paths, writeJsonAtomic } from '../config.js';

export const STATUSES = /** @type {const} */ (['pending', 'running', 'waiting-for-reset', 'done', 'failed']);

/**
 * @typedef {{
 *   id: string,
 *   task: string,
 *   repo: string,
 *   prompt?: string,
 *   tools: string[],
 *   skipPermissions: boolean,
 *   runner: string,
 *   status: typeof STATUSES[number],
 *   createdAt: string,
 *   updatedAt: string,
 *   attempts: number,
 *   notBefore?: string,        ISO time: don't start before this (waiting-for-reset, run --at)
 *   backoffMinutes?: number,
 *   branch?: string,
 *   worktree?: string,
 *   lastError?: string,
 *   logFile?: string,
 *   reportFile?: string,
 *   result?: { costUsd?: number, inputTokens?: number, outputTokens?: number, durationMs?: number, sessionId?: string },
 * }} QueueTask
 */

/** @returns {Promise<{ version: 1, tasks: QueueTask[] }>} */
export async function readQueue() {
  try {
    const data = JSON.parse(await fs.readFile(paths.queue(), 'utf8'));
    return { version: 1, tasks: Array.isArray(data.tasks) ? data.tasks : [] };
  } catch (e) {
    if (/** @type {any} */ (e).code === 'ENOENT') return { version: 1, tasks: [] };
    throw new Error(`Could not read ${paths.queue()}: ${/** @type {Error} */ (e).message}`, { cause: e });
  }
}

/** @param {{ version: 1, tasks: QueueTask[] }} q */
export async function writeQueue(q) {
  await writeJsonAtomic(paths.queue(), q);
}

/**
 * Read-modify-write the queue.
 * @template T
 * @param {(q: { version: 1, tasks: QueueTask[] }) => T | Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function updateQueue(fn) {
  const q = await readQueue();
  const out = await fn(q);
  await writeQueue(q);
  return out;
}

/** Short, sortable, unique id: yyyymmdd-hhmm-xxxx. */
export function newTaskId(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}`;
  return `${stamp}-${crypto.randomBytes(2).toString('hex')}`;
}

/**
 * Add a task.
 * @param {{ task: string, repo: string, prompt?: string, tools: string[], skipPermissions?: boolean, runner: string }} t
 * @returns {Promise<QueueTask>}
 */
export async function addTask(t) {
  if (!t.task?.trim()) throw new Error('Task text is required.');
  const now = new Date().toISOString();
  /** @type {QueueTask} */
  const task = {
    id: newTaskId(),
    task: t.task.trim(),
    repo: t.repo,
    ...(t.prompt ? { prompt: t.prompt } : {}),
    tools: t.tools,
    skipPermissions: Boolean(t.skipPermissions),
    runner: t.runner,
    status: 'pending',
    createdAt: now,
    updatedAt: now,
    attempts: 0,
  };
  await updateQueue((q) => {
    q.tasks.push(task);
  });
  return task;
}

/**
 * Remove a task that isn't running.
 * @param {string} id full id or unique prefix
 */
export async function removeTask(id) {
  return updateQueue((q) => {
    const t = findTask(q.tasks, id);
    if (t.status === 'running') throw new Error(`Task ${t.id} is running; wait for it to finish.`);
    q.tasks = q.tasks.filter((x) => x.id !== t.id);
    return t;
  });
}

/**
 * Patch a task by id.
 * @param {string} id
 * @param {Partial<QueueTask>} patch
 */
export async function patchTask(id, patch) {
  return updateQueue((q) => {
    const t = findTask(q.tasks, id);
    Object.assign(t, patch, { updatedAt: new Date().toISOString() });
    return { ...t };
  });
}

/**
 * @param {QueueTask[]} tasks
 * @param {string} id full id or unique prefix
 */
export function findTask(tasks, id) {
  const exact = tasks.find((t) => t.id === id);
  if (exact) return exact;
  const matches = tasks.filter((t) => t.id.startsWith(id));
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) throw new Error(`"${id}" matches ${matches.length} tasks; use more characters.`);
  throw new Error(`No task with id "${id}".`);
}

/**
 * Next task that may run now: pending or waiting-for-reset whose notBefore has passed. Oldest first.
 * @param {QueueTask[]} tasks
 * @param {Date} [now]
 */
export function nextRunnable(tasks, now = new Date()) {
  return tasks
    .filter((t) => (t.status === 'pending' || t.status === 'waiting-for-reset') && (!t.notBefore || new Date(t.notBefore) <= now))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
}

/**
 * On startup, a task left "running" by a crashed process is marked failed (spec: a crash leaves it failed with its log).
 * @param {(pid: number) => boolean} [isAlive]
 */
export async function recoverCrashed(isAlive = processAlive) {
  return updateQueue((q) => {
    const fixed = [];
    for (const t of q.tasks) {
      if (t.status === 'running' && !(t.pid && isAlive(t.pid))) {
        t.status = 'failed';
        t.lastError = 'The runner stopped unexpectedly while this task was running (crash or closed terminal). See the log.';
        t.updatedAt = new Date().toISOString();
        fixed.push(t.id);
      }
    }
    return fixed;
  });
}

/** @param {number} pid */
function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
