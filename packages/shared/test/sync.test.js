import { describe, it, expect } from 'vitest';
import { createSyncClient, SyncDisabledError, SyncError, assertNoKeys } from '../src/sync.js';

function server(routes) {
  const calls = [];
  const f = async (url, init = {}) => {
    const u = new URL(url);
    const key = `${init.method} ${u.pathname}`;
    calls.push({ key, url: String(url), headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined });
    const h = routes[key];
    if (!h) return new Response(JSON.stringify({ error: { message: 'not found', code: 'not_found' } }), { status: 404 });
    const [status, body] = await h(calls.at(-1));
    return new Response(JSON.stringify(body), { status });
  };
  f.calls = calls;
  return f;
}

describe('sync client', () => {
  it('is local-only without a server URL', async () => {
    const c = createSyncClient({ serverUrl: '' });
    await expect(c.health()).rejects.toBeInstanceOf(SyncDisabledError);
  });

  it('needs sign-in for private routes and sends the bearer token', async () => {
    const f = server({ 'GET /api/v1/me': () => [200, { id: 'u1' }], 'GET /api/v1/health': () => [200, { ok: true }] });
    const c = createSyncClient({ serverUrl: 'http://srv/', fetch: f, client: 'cli' });
    expect(await c.health()).toEqual({ ok: true });
    await expect(c.me()).rejects.toMatchObject({ code: 'not_signed_in' });
    c.setToken('tok');
    expect(await c.me()).toEqual({ id: 'u1' });
    expect(f.calls.at(-1).headers.authorization).toBe('Bearer tok');
    expect(f.calls.at(-1).headers['x-resync-client']).toBe('cli');
    expect(f.calls[0].url).toBe('http://srv/api/v1/health');
  });

  it('runs the device-code flow: pending, slow_down, then a token', async () => {
    let n = 0;
    const f = server({
      'POST /api/v1/auth/device/code': () => [200, { deviceCode: 'dc', userCode: 'ABCD-EFGH', verificationUri: 'http://dash/device', interval: 1, expiresIn: 60 }],
      'POST /api/v1/auth/device/token': () => {
        n++;
        if (n === 1) return [400, { error: { code: 'authorization_pending', message: 'pending' } }];
        if (n === 2) return [400, { error: { code: 'slow_down', message: 'slow' } }];
        return [200, { token: 'new-token', user: { id: 'u1' } }];
      },
      'GET /api/v1/me': () => [200, { id: 'u1' }],
    });
    const c = createSyncClient({ serverUrl: 'http://srv', fetch: f });
    const start = await c.startDeviceLogin('test');
    const sleeps = [];
    let pending = 0;
    const r = await c.pollDeviceToken(start, { sleep: async (ms) => sleeps.push(ms), onPending: () => pending++ });
    expect(r.token).toBe('new-token');
    expect(sleeps).toEqual([1000, 1000, 6000]);
    expect(pending).toBe(1);
    expect(c.signedIn).toBe(true);
    expect(await c.me()).toEqual({ id: 'u1' });
  });

  it('stops polling on denial', async () => {
    const f = server({ 'POST /api/v1/auth/device/token': () => [400, { error: { code: 'access_denied', message: 'denied' } }] });
    const c = createSyncClient({ serverUrl: 'http://srv', fetch: f });
    await expect(c.pollDeviceToken({ deviceCode: 'x', interval: 1 }, { sleep: async () => {} })).rejects.toMatchObject({ code: 'access_denied' });
  });

  it('uploads only valid numbers-only usage records, in batches', async () => {
    const f = server({ 'POST /api/v1/usage': (c) => [200, { accepted: c.body.records.length }] });
    const c = createSyncClient({ serverUrl: 'http://srv', token: 't', fetch: f });
    const good = { user: 'u', project: 'p', sessionId: 's', date: '2026-10-17', source: 'cli', inputTokens: 1 };
    const records = [...Array.from({ length: 501 }, (_, i) => ({ ...good, sessionId: `s${i}` })), { ...good, prompt: 'leak' }];
    const r = await c.uploadUsage(records);
    expect(r).toEqual({ sent: 501, accepted: 501, skipped: 1 });
    expect(f.calls.map((x) => x.body.records.length)).toEqual([500, 1]);
  });

  it('refuses to send anything that looks like an API key', async () => {
    const f = server({ 'PUT /api/v1/me/settings': () => [200, {}] });
    const c = createSyncClient({ serverUrl: 'http://srv', token: 't', fetch: f });
    await expect(c.putSettings({ note: 'sk-ant-abcdefghijklmnop' })).rejects.toMatchObject({ code: 'key_detected' });
    expect(f.calls).toHaveLength(0);
    expect(() => assertNoKeys({ a: 'AIzaSyA1234567890abcdefghijk' })).toThrow(SyncError);
    expect(() => assertNoKeys({ a: 'risk-assessment' })).not.toThrow();
  });

  it('reports server and network errors clearly', async () => {
    const c = createSyncClient({ serverUrl: 'http://srv', token: 't', fetch: server({}) });
    await expect(c.listShared()).rejects.toMatchObject({ status: 404, code: 'not_found' });
    const down = createSyncClient({ serverUrl: 'http://srv', token: 't', fetch: async () => { throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } }); } });
    await expect(down.me()).rejects.toThrow(/ECONNREFUSED/);
  });
});
