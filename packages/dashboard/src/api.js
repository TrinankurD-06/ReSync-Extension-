// Dashboard API client: cookie session + the CSRF header the server requires on writes.
// Server URL from VITE_RESYNC_SERVER_URL; blank = same origin (docker-compose / the server serving the dashboard).
const BASE = (import.meta.env.VITE_RESYNC_SERVER_URL ?? '').replace(/\/+$/, '');

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/**
 * @param {string} method
 * @param {string} path  e.g. "/me" (prefixed with /api/v1)
 * @param {unknown} [body]
 */
export async function api(method, path, body) {
  const res = await fetch(`${BASE}/api/v1${path}`, {
    method,
    credentials: 'include',
    headers: { accept: 'application/json', ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(method !== 'GET' ? { 'x-resync-csrf': '1' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON */
  }
  if (!res.ok) throw new ApiError(res.status, data?.error?.code ?? 'error', data?.error?.message ?? `Request failed (${res.status})`);
  return data;
}

export const get = (p) => api('GET', p);
export const post = (p, b) => api('POST', p, b ?? {});
export const put = (p, b) => api('PUT', p, b ?? {});
export const patch = (p, b) => api('PATCH', p, b ?? {});
export const del = (p, b) => api('DELETE', p, b);

/** Full URL of a server route (for links that leave the app, like OAuth start). */
export const serverUrl = (p) => `${BASE}/api/v1${p}`;
