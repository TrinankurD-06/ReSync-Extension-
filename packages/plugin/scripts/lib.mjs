// Small helpers shared by the plugin's hook and statusline scripts.
// Dependency-free on purpose: an installed plugin has no node_modules.
import { promises as fs, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** ReSync's data folder (same rule as the CLI): RESYNC_HOME or ~/.resync */
export function resyncHome() {
  return process.env.RESYNC_HOME || path.join(os.homedir(), '.resync');
}

export const files = {
  usage: () => path.join(resyncHome(), 'usage.jsonl'),
  markers: () => path.join(resyncHome(), 'compact-markers'),
  sessions: () => path.join(resyncHome(), 'sessions'),
  pending: () => path.join(resyncHome(), 'pending'),
  config: () => path.join(resyncHome(), 'config.json'),
};

/** Read all of stdin as text (hooks and the statusline receive JSON on stdin). */
export async function readStdin() {
  let data = '';
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

/** Parse JSON, or return null. @param {string} s */
export function parseJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/** Local calendar date YYYY-MM-DD. @param {Date} [d] */
export function localDate(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Ids from Claude Code are used in file names; keep them safe. @param {unknown} id */
export function safeId(id) {
  const s = String(id ?? '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
  return s || 'unknown';
}

/** The ReSync user name: config "user", RESYNC_USER, or the OS user. */
export function resyncUser() {
  if (process.env.RESYNC_USER) return process.env.RESYNC_USER;
  try {
    const cfg = JSON.parse(readFileSync(files.config(), 'utf8'));
    if (typeof cfg.user === 'string' && cfg.user) return cfg.user;
  } catch {
    /* no config yet */
  }
  try {
    return os.userInfo().username || 'me';
  } catch {
    return 'me';
  }
}

/** @param {string} file @param {unknown} data */
export async function writeJson(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data));
  await fs.rename(tmp, file);
}

/** @param {string} file */
export async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

const NUMBER_FIELDS = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheCreationTokens', 'costUsd', 'messages', 'estimatedTokens', 'durationMs'];

/**
 * Append one usage record (numbers only; mirrors the strict schema in @resync/shared/usage).
 * @param {Record<string, unknown>} r
 */
export async function appendUsage(r) {
  const rec = {
    user: String(r.user),
    project: String(r.project),
    sessionId: String(r.sessionId),
    date: String(r.date),
    source: 'plugin',
    ...(typeof r.model === 'string' && r.model ? { model: r.model.slice(0, 200) } : {}),
    isEstimate: true,
  };
  for (const k of NUMBER_FIELDS) {
    const v = r[k];
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) rec[k] = v;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(rec.date)) throw new Error('bad date');
  await fs.mkdir(path.dirname(files.usage()), { recursive: true });
  await fs.appendFile(files.usage(), JSON.stringify(rec) + '\n');
  return rec;
}
