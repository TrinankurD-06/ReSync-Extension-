import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { useDb, makeApp, signIn, personalToken, logLines } from './helpers.js';
import { Token, DeviceCode } from '../src/models/index.js';
import { loadConfig } from '../src/config.js';

useDb();

describe('server basics', () => {
  it('health, security headers, CORS allowlist and JSON 404s', async () => {
    const app = makeApp();
    const r = await request(app).get('/api/v1/health').set('origin', 'http://dash.test');
    expect(r.body).toEqual({ ok: true, service: 'resync-server', version: '0.1.0' });
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['access-control-allow-origin']).toBe('http://dash.test');
    expect(r.headers['x-powered-by']).toBeUndefined();
    const ext = await request(app).get('/api/v1/health').set('origin', 'chrome-extension://abcdefghijklmnop');
    expect(ext.headers['access-control-allow-origin']).toBe('chrome-extension://abcdefghijklmnop');
    const evil = await request(app).get('/api/v1/health').set('origin', 'https://evil.example');
    expect(evil.headers['access-control-allow-origin']).toBeUndefined();
    expect((await request(app).get('/api/v1/nope')).body.error.code).toBe('not_found');
  });

  it('rate limits sign-in attempts when enabled', async () => {
    const app = makeApp({ rateLimits: true });
    let last;
    for (let i = 0; i < 61; i++) last = await request(app).post('/api/v1/auth/device/code').send({});
    expect(last.status).toBe(429);
    expect(last.body.error.code).toBe('rate_limited');
  });

  it('refuses unsafe production config', () => {
    expect(() => loadConfig({ NODE_ENV: 'production', SESSION_SECRET: 'short' })).toThrow(/SESSION_SECRET/);
    expect(() => loadConfig({ NODE_ENV: 'production', SESSION_SECRET: 'x'.repeat(40), ALLOW_DEV_LOGIN: 'true' })).toThrow(/DEV_LOGIN/);
  });
});

describe('auth', () => {
  it('dev login creates a session; /me needs it; CSRF header is required on cookie writes', async () => {
    const app = makeApp();
    expect((await request(app).get('/api/v1/me')).status).toBe(401);
    const a = await signIn(app, 'alice@example.com', 'Alice');
    expect((await a.get('/api/v1/me')).body).toMatchObject({ name: 'Alice', email: 'alice@example.com', team: null });
    const noCsrf = await a.agent.put('/api/v1/me/settings').send({ settings: {} });
    expect(noCsrf.status).toBe(403);
    expect((await a.put('/api/v1/me/settings', { settings: { theme: 'dark' } })).status).toBe(200);
  });

  it('dev login is off unless enabled', async () => {
    const app = makeApp({ config: { allowDevLogin: false } });
    expect((await request(app).post('/api/v1/auth/dev-login').send({ email: 'a@b.co' })).status).toBe(404);
  });

  it('device-code flow: pending, slow_down, approve, one token, revocable', async () => {
    const app = makeApp();
    const alice = await signIn(app, 'alice@example.com', 'Alice');
    const start = await request(app).post('/api/v1/auth/device/code').send({ label: 'resync CLI on laptop' });
    expect(start.body).toMatchObject({ verificationUri: 'http://dash.test/device', interval: 5, expiresIn: 900 });
    expect(start.body.userCode).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    const poll = () => request(app).post('/api/v1/auth/device/token').send({ deviceCode: start.body.deviceCode });
    expect((await poll()).body.error.code).toBe('authorization_pending');
    expect((await poll()).body.error.code).toBe('slow_down');
    expect((await alice.post('/api/v1/auth/device/approve', { userCode: start.body.userCode.toLowerCase(), approve: true })).body).toMatchObject({ approved: true, label: 'resync CLI on laptop' });
    await DeviceCode.updateMany({}, { lastPolledAt: new Date(0) });
    const tok = await poll();
    expect(tok.body.token).toMatch(/^rlp_/);
    expect(tok.body.user.name).toBe('Alice');
    expect((await poll()).body.error.code).toBe('invalid_grant'); // only once

    const me = await request(app).get('/api/v1/me').set('authorization', `Bearer ${tok.body.token}`);
    expect(me.body.name).toBe('Alice');
    // Bearer writes need no CSRF header.
    expect((await request(app).put('/api/v1/me/settings').set('authorization', `Bearer ${tok.body.token}`).send({ settings: {} })).status).toBe(200);

    const list = await alice.get('/api/v1/tokens');
    const cli = list.body.tokens.find((t) => t.label === 'resync CLI on laptop');
    expect(cli.kind).toBe('personal');
    expect(JSON.stringify(list.body)).not.toMatch(/hash|rlp_/);
    await alice.del(`/api/v1/tokens/${cli.id}`);
    expect((await request(app).get('/api/v1/me').set('authorization', `Bearer ${tok.body.token}`)).status).toBe(401);
  });

  it('denied and expired device codes', async () => {
    const app = makeApp();
    const alice = await signIn(app, 'alice@example.com');
    const s = await request(app).post('/api/v1/auth/device/code').send({});
    await alice.post('/api/v1/auth/device/approve', { userCode: s.body.userCode, approve: false });
    expect((await request(app).post('/api/v1/auth/device/token').send({ deviceCode: s.body.deviceCode })).body.error.code).toBe('access_denied');
    const s2 = await request(app).post('/api/v1/auth/device/code').send({});
    await DeviceCode.updateOne({ userCode: s2.body.userCode }, { expiresAt: new Date(Date.now() - 1000) });
    expect((await request(app).post('/api/v1/auth/device/token').send({ deviceCode: s2.body.deviceCode })).body.error.code).toBe('expired_token');
    expect((await alice.post('/api/v1/auth/device/approve', { userCode: s2.body.userCode, approve: true })).status).toBe(404);
  });

  it('logout revokes the session; tokens are stored hashed', async () => {
    const app = makeApp();
    const a = await signIn(app, 'bob@example.com');
    const t = await personalToken(app, a);
    const stored = await Token.find({}).lean();
    expect(JSON.stringify(stored)).not.toContain(t);
    await a.post('/api/v1/auth/logout');
    expect((await a.get('/api/v1/me')).status).toBe(401);
  });

  it('GitHub OAuth: state + PKCE, user keyed on GitHub id, session cookie, redirect to dashboard', async () => {
    const calls = [];
    const fetch = async (url, init = {}) => {
      calls.push({ url: String(url), init });
      if (String(url).includes('access_token')) return new Response(JSON.stringify({ access_token: 'gho_x' }));
      if (String(url).endsWith('/user')) return new Response(JSON.stringify({ id: 42, login: 'octo', name: 'Octo Cat', avatar_url: 'https://avatars.githubusercontent.com/u/42', email: null }));
      if (String(url).endsWith('/user/emails')) return new Response(JSON.stringify([{ email: 'octo@example.com', primary: true, verified: true }]));
      return new Response('{}', { status: 404 });
    };
    const app = makeApp({ fetch });
    const agent = request.agent(app);
    const start = await agent.get('/api/v1/auth/github/start?next=/team');
    expect(start.status).toBe(302);
    const loc = new URL(start.headers.location);
    expect(loc.origin + loc.pathname).toBe('https://github.com/login/oauth/authorize');
    expect(loc.searchParams.get('code_challenge_method')).toBe('S256');
    expect(loc.searchParams.get('redirect_uri')).toBe('http://api.test/api/v1/auth/github/callback');
    expect(loc.searchParams.get('scope')).toBe('read:user user:email');

    expect((await agent.get('/api/v1/auth/github/callback?code=c&state=wrong')).body.error.code).toBe('bad_state');
    const again = await agent.get('/api/v1/auth/github/start?next=/team');
    const state = new URL(again.headers.location).searchParams.get('state');
    const cb = await agent.get(`/api/v1/auth/github/callback?code=abc&state=${state}`);
    expect(cb.status).toBe(302);
    expect(cb.headers.location).toBe('http://dash.test/team');
    const tokenCall = calls.find((c) => c.url.includes('access_token'));
    expect(tokenCall.init.body).toContain('code_verifier=');
    expect((await agent.get('/api/v1/me')).body).toMatchObject({ name: 'Octo Cat', email: 'octo@example.com' });
  });

  it('Google OAuth uses the userinfo subject, and unconfigured providers say so', async () => {
    const fetch = async (url) => (String(url).includes('oauth2.googleapis.com/token')
      ? new Response(JSON.stringify({ access_token: 'ya29' }))
      : new Response(JSON.stringify({ sub: 'g-123', name: 'Gee', email: 'gee@example.com', email_verified: true })));
    const app = makeApp({ fetch });
    const agent = request.agent(app);
    const start = await agent.get('/api/v1/auth/google/start');
    expect(new URL(start.headers.location).searchParams.get('scope')).toBe('openid email profile');
    const state = new URL(start.headers.location).searchParams.get('state');
    await agent.get(`/api/v1/auth/google/callback?code=x&state=${state}`);
    expect((await agent.get('/api/v1/me')).body.name).toBe('Gee');

    const bare = makeApp({ config: { github: { clientId: '', clientSecret: '' } } });
    expect((await request(bare).get('/api/v1/auth/github/start')).body.error.code).toBe('not_configured');
    expect((await request(bare).get('/api/v1/auth/providers')).body).toEqual({ github: false, google: true, dev: true });
  });

  it('logs requests without tokens, cookies or bodies', async () => {
    const app = makeApp();
    const a = await signIn(app, 'carol@example.com');
    const t = await personalToken(app, a);
    await request(app).put('/api/v1/me/settings').set('authorization', `Bearer ${t}`).send({ settings: { secretNote: 'do-not-log-me' } });
    const all = logLines.join('\n');
    expect(all).toContain('"path":"/api/v1/me/settings"');
    expect(all).not.toContain(t);
    expect(all).not.toContain('do-not-log-me');
    expect(all).not.toContain('resync_session=');
  });
});
