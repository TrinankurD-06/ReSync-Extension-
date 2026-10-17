// Sync client used by the CLI and the extension to talk to a ReSync team server (REST, /api/v1).
// The server is optional: with no server URL, ReSync is local-only and this client refuses politely.
// Only prompts, settings, colours and usage NUMBERS are sent. Conversation content is sent only when
// the user explicitly shares a passport/summary/tree. API keys are never sent.
import { validateUsageRecord } from './usage.js';

export class SyncError extends Error {
  /** @param {string} message @param {{ status?: number, code?: string }} [o] */
  constructor(message, o = {}) {
    super(message);
    this.name = 'SyncError';
    this.status = o.status;
    this.code = o.code;
  }
}

/** Thrown when no server is configured (local-only mode). */
export class SyncDisabledError extends SyncError {
  constructor() {
    super('No ReSync server configured: running local-only. Set a server URL to sync (CLI: `resync config set serverUrl <url>`).', { code: 'local_only' });
    this.name = 'SyncDisabledError';
  }
}

const KEY_LIKE = /\b(sk-[A-Za-z0-9_-]{8,}|sk-ant-[A-Za-z0-9_-]{8,}|AIza[0-9A-Za-z_-]{20,}|sk-or-[A-Za-z0-9_-]{8,})\b/;

/**
 * Refuse to upload anything that looks like an API key (defence in depth for "keys never touch the server").
 * @param {unknown} payload
 */
export function assertNoKeys(payload) {
  const s = JSON.stringify(payload ?? null);
  if (KEY_LIKE.test(s)) throw new SyncError('Refusing to sync: the payload contains something that looks like an API key.', { code: 'key_detected' });
}

/**
 * @param {{ serverUrl?: string, token?: string, fetch?: typeof fetch, client?: string }} opts
 *   client: 'cli' | 'extension' (sent as a header for the server's logs; no other telemetry)
 */
export function createSyncClient(opts) {
  const base = (opts.serverUrl ?? '').trim().replace(/\/+$/, '');
  const f = opts.fetch ?? globalThis.fetch;
  let token = opts.token;

  /**
   * @param {string} method
   * @param {string} path
   * @param {unknown} [body]
   * @param {{ auth?: boolean }} [o]
   */
  async function call(method, path, body, o = {}) {
    if (!base) throw new SyncDisabledError();
    if (o.auth !== false && !token) throw new SyncError('Not signed in. Run `resync login` (CLI) or sign in from Settings (extension).', { status: 401, code: 'not_signed_in' });
    if (body !== undefined) assertNoKeys(body);
    let res;
    try {
      res = await f(`${base}/api/v1${path}`, {
        method,
        headers: {
          accept: 'application/json',
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(o.auth !== false && token ? { authorization: `Bearer ${token}` } : {}),
          ...(opts.client ? { 'x-resync-client': opts.client } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(30_000),
      });
    } catch (e) {
      throw new SyncError(`Could not reach the ReSync server at ${base} (${/** @type {any} */ (e)?.cause?.code ?? /** @type {any} */ (e)?.message ?? e}).`, { code: 'network' });
    }
    const text = await res.text();
    let data;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { error: { message: text.slice(0, 200) } };
    }
    if (!res.ok) {
      throw new SyncError(data?.error?.message ?? `Server error (HTTP ${res.status})`, { status: res.status, code: data?.error?.code });
    }
    return data;
  }

  return {
    get serverUrl() {
      return base;
    },
    get signedIn() {
      return Boolean(token);
    },
    /** @param {string | undefined} t */
    setToken(t) {
      token = t;
    },

    health: () => call('GET', '/health', undefined, { auth: false }),
    me: () => call('GET', '/me'),

    // ---- Device-code login (CLI and extension) ----
    /** @param {string} [label] e.g. "resync CLI on laptop" */
    startDeviceLogin: (label) => call('POST', '/auth/device/code', { label: label ?? opts.client ?? 'resync' }, { auth: false }),
    /**
     * Poll until the user approves in the dashboard. Resolves to { token, user }.
     * @param {{ deviceCode: string, interval?: number, expiresIn?: number }} start
     * @param {{ signal?: AbortSignal, sleep?: (ms: number) => Promise<void>, onPending?: () => void }} [o]
     */
    async pollDeviceToken(start, o = {}) {
      const sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
      let interval = Math.max(1, start.interval ?? 5) * 1000;
      const deadline = Date.now() + (start.expiresIn ?? 900) * 1000;
      while (Date.now() < deadline) {
        if (o.signal?.aborted) throw new SyncError('Login cancelled', { code: 'cancelled' });
        await sleep(interval);
        try {
          const r = await call('POST', '/auth/device/token', { deviceCode: start.deviceCode }, { auth: false });
          token = r.token;
          return r;
        } catch (e) {
          const code = /** @type {SyncError} */ (e).code;
          if (code === 'authorization_pending') {
            o.onPending?.();
            continue;
          }
          if (code === 'slow_down') {
            interval += 5000;
            continue;
          }
          throw e;
        }
      }
      throw new SyncError('Login code expired. Run the login again.', { code: 'expired_token' });
    },
    logout: () => call('POST', '/auth/logout', {}),

    // ---- Prompts ----
    /** Personal + team prompts as a portable library ({ format, version, prompts }). */
    getLibrary: () => call('GET', '/prompts/library'),
    /** @param {'personal' | 'team' | 'all'} [scope] */
    listPrompts: (scope = 'all') => call('GET', `/prompts?scope=${encodeURIComponent(scope)}`),
    /** @param {import('./prompts.js').Prompt} prompt */
    createPrompt: (prompt) => call('POST', '/prompts', { prompt }),
    /** @param {string} id @param {import('./prompts.js').Prompt} prompt */
    updatePrompt: (id, prompt) => call('PUT', `/prompts/${encodeURIComponent(id)}`, { prompt }),
    /** Create or update by (scope, category, slug). @param {import('./prompts.js').Prompt} prompt */
    upsertPrompt: (prompt) => call('PUT', '/prompts/by-slug', { prompt }),
    /** @param {string} id */
    deletePrompt: (id) => call('DELETE', `/prompts/${encodeURIComponent(id)}`),

    // ---- Settings and colours (no secrets) ----
    getSettings: () => call('GET', '/me/settings'),
    /** @param {Record<string, unknown>} settings */
    putSettings: (settings) => call('PUT', '/me/settings', { settings }),
    getColours: () => call('GET', '/colours'),
    /** @param {{ presets: unknown[], assignments: Record<string, string> }} colours */
    putColours: (colours) => call('PUT', '/colours', colours),

    // ---- Usage (numbers only) ----
    /**
     * Upload usage records in batches. Invalid records (or ones with any non-number field) are skipped and reported.
     * @param {unknown[]} records
     */
    async uploadUsage(records) {
      const valid = [];
      const skipped = [];
      for (const r of records) {
        const v = validateUsageRecord(r);
        if (v.ok) valid.push(v.record);
        else skipped.push({ record: r, errors: v.errors });
      }
      let accepted = 0;
      for (let i = 0; i < valid.length; i += 500) {
        const r = await call('POST', '/usage', { records: valid.slice(i, i + 500) });
        accepted += r?.accepted ?? 0;
      }
      return { sent: valid.length, accepted, skipped: skipped.length };
    },
    /** @param {{ from?: string, to?: string, groupBy?: 'user' | 'project' | 'day' }} [q] */
    getUsage: (q = {}) => call('GET', `/usage?${new URLSearchParams(/** @type {any} */ (q)).toString()}`),

    // ---- Queue reports and explicitly shared items ----
    /** @param {{ taskId: string, title: string, status: string, summary: string, branch?: string, filesChanged?: string[], testsRun?: string, startedAt?: string, finishedAt?: string }} report */
    uploadQueueReport: (report) => call('POST', '/queue-reports', report),
    /**
     * Share a passport, summary or tree with the team. This is the ONLY way conversation-derived
     * content reaches the server, and it is always a per-item, user-initiated action.
     * @param {{ kind: 'passport' | 'summary' | 'tree', title: string, content: string, project?: string }} item
     */
    share: (item) => call('POST', '/shared', item),
    listShared: () => call('GET', '/shared'),
  };
}

/** @typedef {ReturnType<typeof createSyncClient>} SyncClient */
