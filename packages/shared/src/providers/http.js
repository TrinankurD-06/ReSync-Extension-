// HTTP helper shared by adapters: JSON requests, timeouts, error normalisation.
import { classifyHttpError, networkError } from './errors.js';

/**
 * @typedef {{
 *   fetch?: typeof fetch,
 *   signal?: AbortSignal,
 *   timeoutMs?: number,
 * }} HttpOptions
 */

/**
 * POST/GET JSON and return the Response, throwing a ProviderError for non-2xx or network failures.
 * @param {string} provider name used in error messages
 * @param {string} url
 * @param {{ method?: string, headers?: Record<string, string>, body?: unknown }} req
 * @param {HttpOptions} [opts]
 */
export async function requestJson(provider, url, req, opts = {}) {
  const f = opts.fetch ?? globalThis.fetch;
  const signals = [opts.signal, AbortSignal.timeout(opts.timeoutMs ?? 120_000)].filter(Boolean);
  let res;
  try {
    res = await f(url, {
      method: req.method ?? (req.body === undefined ? 'GET' : 'POST'),
      headers: { ...(req.body === undefined ? {} : { 'content-type': 'application/json' }), ...req.headers },
      body: req.body === undefined ? undefined : JSON.stringify(req.body),
      signal: signals.length > 1 ? AbortSignal.any(/** @type {AbortSignal[]} */ (signals)) : signals[0],
    });
  } catch (e) {
    throw networkError(provider, e);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let body = text;
    try {
      body = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    throw classifyHttpError({ provider, status: res.status, body, headers: res.headers });
  }
  return res;
}

/**
 * Join a base URL and a path without double slashes.
 * @param {string} base
 * @param {string} path
 */
export function joinUrl(base, path) {
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}
