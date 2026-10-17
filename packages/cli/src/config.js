// CLI configuration: ~/.resync/config.json (override the folder with RESYNC_HOME).
// Holds settings, the feature -> model map and the limit-detection patterns. Never holds API keys.
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseAiSettings, defaultAiSettings } from '@resync/shared/models';

/** Folder for all ReSync state on this machine. */
export function resyncHome() {
  return process.env.RESYNC_HOME || path.join(os.homedir(), '.resync');
}

export const paths = {
  config: () => path.join(resyncHome(), 'config.json'),
  queue: () => path.join(resyncHome(), 'queue.json'),
  usage: () => path.join(resyncHome(), 'usage.jsonl'),
  logs: () => path.join(resyncHome(), 'logs'),
  markers: () => path.join(resyncHome(), 'compact-markers'),
  auth: () => path.join(resyncHome(), 'auth.json'),
  syncState: () => path.join(resyncHome(), 'sync-state.json'),
};

/**
 * Default limit-detection patterns (regex sources, case-insensitive). They live in config so users can
 * adapt them when Claude Code's wording changes; nothing in code depends on exact wording.
 * Based on the documented messages, e.g. "You've hit your session limit · resets 3:45pm" (docs/VERIFIED.md).
 */
export const DEFAULT_LIMIT_PATTERNS = [
  "you['’]ve hit your (?:session|weekly|daily|opus|sonnet|fable|haiku|usage|monthly spend)? ?limit",
  'usage limit (?:reached|exceeded)',
  'limit reached',
  'rate limit(?:ed)?',
  'request rejected \\(429\\)',
  'server is temporarily limiting requests',
  'credit balance is too low',
  'monthly spend limit',
  'overloaded_error',
];

/** Default tool allowlist for queued tasks: read, edit, run tests (Claude Code permission rule syntax). */
export const DEFAULT_TOOLS = ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash(npm test *)', 'Bash(npm run test *)', 'Bash(npx vitest *)', 'Bash(git status *)', 'Bash(git diff *)'];

/**
 * @typedef {{
 *   user: string,
 *   serverUrl: string,
 *   ai: import('@resync/shared/models').AiSettings,
 *   keys: { providers: string[] },
 *   queue: {
 *     runner: string,
 *     claudeCommand: string,
 *     defaultTools: string[],
 *     limitPatterns: string[],
 *     backoff: { initialMinutes: number, maxMinutes: number },
 *     taskTimeoutMinutes: number,
 *     uploadReports: boolean,
 *   },
 *   plugin: { commandsDir: string },
 * }} ReSyncConfig
 */

/** @returns {ReSyncConfig} */
export function defaultConfig() {
  return {
    user: process.env.RESYNC_USER || os.userInfo().username || 'me',
    serverUrl: '',
    ai: defaultAiSettings(),
    keys: { providers: [] },
    queue: {
      runner: 'claude-code',
      claudeCommand: 'claude',
      defaultTools: DEFAULT_TOOLS,
      limitPatterns: DEFAULT_LIMIT_PATTERNS,
      backoff: { initialMinutes: 15, maxMinutes: 120 },
      taskTimeoutMinutes: 120,
      uploadReports: false,
    },
    plugin: { commandsDir: '' },
  };
}

/** Deep-merge plain objects (arrays are replaced). */
function merge(base, over) {
  if (!over || typeof over !== 'object' || Array.isArray(over)) return over ?? base;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && base?.[k] && typeof base[k] === 'object' ? merge(base[k], v) : v;
  }
  return out;
}

/**
 * Load config, filling defaults. A missing file is fine (fresh install). Env overrides: RESYNC_SERVER_URL, RESYNC_USER.
 * @returns {Promise<ReSyncConfig>}
 */
export async function loadConfig() {
  let raw = {};
  try {
    raw = JSON.parse(await fs.readFile(paths.config(), 'utf8'));
  } catch (e) {
    if (/** @type {any} */ (e).code !== 'ENOENT') throw new Error(`Could not read ${paths.config()}: ${/** @type {Error} */ (e).message}`, { cause: e });
  }
  /** @type {ReSyncConfig} */
  const cfg = merge(defaultConfig(), raw);
  cfg.ai = parseAiSettings(cfg.ai);
  if (process.env.RESYNC_SERVER_URL !== undefined) cfg.serverUrl = process.env.RESYNC_SERVER_URL;
  if (process.env.RESYNC_USER) cfg.user = process.env.RESYNC_USER;
  return cfg;
}

/**
 * Save config atomically (write temp file, then rename).
 * @param {ReSyncConfig} cfg
 */
export async function saveConfig(cfg) {
  await writeJsonAtomic(paths.config(), cfg);
}

/**
 * @param {string} file
 * @param {unknown} data
 */
export async function writeJsonAtomic(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  await fs.rename(tmp, file);
}

/**
 * Read a dotted key, e.g. "queue.backoff.initialMinutes".
 * @param {any} obj
 * @param {string} key
 */
export function getPath(obj, key) {
  return key.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

/**
 * Set a dotted key. Values are parsed as JSON when possible ("15" -> 15, "true" -> true, '["a"]' -> array).
 * @param {any} obj
 * @param {string} key
 * @param {string} value
 */
export function setPath(obj, key, value) {
  let v = value;
  try {
    v = JSON.parse(value);
  } catch {
    /* keep string */
  }
  const parts = key.split('.');
  let o = obj;
  for (const p of parts.slice(0, -1)) {
    if (o[p] == null || typeof o[p] !== 'object') o[p] = {};
    o = o[p];
  }
  o[parts.at(-1)] = v;
  return obj;
}
