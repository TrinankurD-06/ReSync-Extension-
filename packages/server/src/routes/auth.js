// Sign-in: GitHub / Google OAuth (web flow with state + PKCE), a dev-only login, and a device-code flow for
// the CLI and extension that ends in a revocable personal token. Endpoints: docs/VERIFIED.md ("OAuth").
import { Router } from 'express';
import crypto from 'node:crypto';
import { z } from 'zod';
import { User, Token, DeviceCode } from '../models/index.js';
import { authProviders } from '../config.js';
import { issueToken, hashToken, randomToken, SESSION_COOKIE, sessionCookieOptions, requireUser, userCode, pkce } from '../lib/auth.js';
import { validate, badRequest, notFound, HttpError, objectId } from '../lib/http.js';

const OAUTH_COOKIE = 'resync_oauth';
const DEVICE_TTL_S = 900;
const DEVICE_INTERVAL_S = 5;

/**
 * @param {import('../config.js').ServerConfig} cfg
 * @param {{ fetch?: typeof fetch }} [deps]
 */
export function authRoutes(cfg, deps = {}) {
  const f = deps.fetch ?? globalThis.fetch;
  const r = Router();

  /** Find or create the user for an identity; never keyed on email. */
  async function upsertUser(provider, subject, profile) {
    let user = await User.findOne({ identities: { $elemMatch: { provider, subject } } });
    if (!user) user = await User.create({ name: profile.name || profile.email || 'ReSync user', email: profile.email, avatarUrl: profile.avatarUrl, identities: [{ provider, subject }] });
    else if (profile.name && user.name !== profile.name) await User.updateOne({ _id: user._id }, { name: profile.name, avatarUrl: profile.avatarUrl });
    return user;
  }

  /** Start a dashboard session and send the browser back to the dashboard. */
  async function startSession(res, user, next = '/') {
    const { raw } = await issueToken(user._id, 'session', 'dashboard');
    res.cookie(SESSION_COOKIE, raw, sessionCookieOptions(cfg));
    const safeNext = typeof next === 'string' && next.startsWith('/') && !next.startsWith('//') ? next : '/';
    res.redirect(302, `${cfg.dashboardUrl}${safeNext}`);
  }

  r.get('/auth/providers', (_req, res) => res.json(authProviders(cfg)));

  // ---- OAuth (GitHub, Google) ----
  const OAUTH = {
    github: {
      authorize: 'https://github.com/login/oauth/authorize',
      token: 'https://github.com/login/oauth/access_token',
      scope: 'read:user user:email',
      creds: cfg.github,
      async profile(accessToken) {
        const headers = { authorization: `Bearer ${accessToken}`, accept: 'application/vnd.github+json', 'user-agent': 'resync-server' };
        const u = await (await f('https://api.github.com/user', { headers })).json();
        let email = u.email;
        if (!email) {
          const emails = await (await f('https://api.github.com/user/emails', { headers })).json().catch(() => []);
          email = Array.isArray(emails) ? (emails.find((e) => e.primary && e.verified) ?? emails.find((e) => e.verified))?.email : undefined;
        }
        if (u.id == null) throw new HttpError(502, 'oauth_failed', 'GitHub did not return a user id.');
        return { subject: String(u.id), name: u.name || u.login, email, avatarUrl: u.avatar_url };
      },
    },
    google: {
      authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
      token: 'https://oauth2.googleapis.com/token',
      scope: 'openid email profile',
      creds: cfg.google,
      async profile(accessToken) {
        const u = await (await f('https://openidconnect.googleapis.com/v1/userinfo', { headers: { authorization: `Bearer ${accessToken}` } })).json();
        if (!u.sub) throw new HttpError(502, 'oauth_failed', 'Google did not return a user id.');
        return { subject: String(u.sub), name: u.name, email: u.email_verified === false ? undefined : u.email, avatarUrl: u.picture };
      },
    },
  };

  for (const [provider, p] of Object.entries(OAUTH)) {
    const callback = `${cfg.publicServerUrl}/api/v1/auth/${provider}/callback`;

    r.get(`/auth/${provider}/start`, (req, res) => {
      if (!p.creds.clientId) throw badRequest(`${provider} sign-in is not configured on this server.`, 'not_configured');
      const state = crypto.randomBytes(16).toString('base64url');
      const { verifier, challenge } = pkce();
      res.cookie(OAUTH_COOKIE, JSON.stringify({ provider, state, verifier, next: req.query.next ?? '/' }), { httpOnly: true, sameSite: 'lax', secure: cfg.production, maxAge: 10 * 60_000, signed: true, path: '/api/v1/auth' });
      const url = new URL(p.authorize);
      url.search = new URLSearchParams({ client_id: p.creds.clientId, redirect_uri: callback, scope: p.scope, state, code_challenge: challenge, code_challenge_method: 'S256', response_type: 'code' }).toString();
      res.redirect(302, url.toString());
    });

    r.get(`/auth/${provider}/callback`, async (req, res) => {
      let saved;
      try {
        saved = JSON.parse(req.signedCookies?.[OAUTH_COOKIE] ?? 'null');
      } catch {
        saved = null;
      }
      res.clearCookie(OAUTH_COOKIE, { path: '/api/v1/auth' });
      if (!saved || saved.provider !== provider || saved.state !== req.query.state) throw badRequest('Sign-in expired or was tampered with. Please try again.', 'bad_state');
      if (!req.query.code) throw badRequest(`Sign-in was cancelled (${req.query.error ?? 'no code'}).`, 'oauth_cancelled');
      const tokenRes = await f(p.token, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: p.creds.clientId, client_secret: p.creds.clientSecret, code: String(req.query.code), redirect_uri: callback, code_verifier: saved.verifier, grant_type: 'authorization_code' }).toString(),
      });
      const tok = await tokenRes.json().catch(() => ({}));
      if (!tok.access_token) throw new HttpError(502, 'oauth_failed', `${provider} sign-in failed (${tok.error ?? tokenRes.status}).`);
      const profile = await p.profile(tok.access_token);
      const user = await upsertUser(provider, profile.subject, profile);
      await startSession(res, user, saved.next);
    });
  }

  // ---- Dev login: local development and tests only (refused in production by config) ----
  r.post('/auth/dev-login', async (req, res) => {
    if (!cfg.allowDevLogin) throw notFound();
    const body = validate(z.object({ email: z.string().email(), name: z.string().min(1).max(200).optional() }), req.body);
    const user = await upsertUser('dev', body.email.toLowerCase(), { name: body.name ?? body.email.split('@')[0], email: body.email });
    const { raw } = await issueToken(user._id, 'session', 'dev');
    res.cookie(SESSION_COOKIE, raw, sessionCookieOptions(cfg));
    res.json({ user: publicUser(user) });
  });

  r.post('/auth/logout', async (req, res) => {
    if (req.token) await Token.updateOne({ _id: req.token._id }, { revokedAt: new Date() });
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.json({ ok: true });
  });

  // ---- Device-code flow (CLI and extension) ----
  r.post('/auth/device/code', async (req, res) => {
    const body = validate(z.object({ label: z.string().max(120).optional() }), req.body ?? {});
    const deviceCode = randomToken('dev');
    const code = userCode();
    await DeviceCode.create({ deviceCodeHash: hashToken(deviceCode), userCode: code, label: body.label ?? 'ReSync client', interval: DEVICE_INTERVAL_S, expiresAt: new Date(Date.now() + DEVICE_TTL_S * 1000) });
    res.json({ deviceCode, userCode: code, verificationUri: `${cfg.dashboardUrl}/device`, verificationUriComplete: `${cfg.dashboardUrl}/device?code=${code}`, expiresIn: DEVICE_TTL_S, interval: DEVICE_INTERVAL_S });
  });

  /** The signed-in user (dashboard) approves or denies a code shown by the CLI/extension. */
  r.post('/auth/device/approve', requireUser, async (req, res) => {
    const body = validate(z.object({ userCode: z.string().min(4).max(20), approve: z.boolean() }), req.body);
    const dc = await DeviceCode.findOne({ userCode: body.userCode.trim().toUpperCase(), status: 'pending', expiresAt: { $gt: new Date() } });
    if (!dc) throw notFound('That code is unknown or has expired. Start the login again.');
    await DeviceCode.updateOne({ _id: dc._id }, { status: body.approve ? 'approved' : 'denied', userId: req.user._id });
    res.json({ ok: true, label: dc.label, approved: body.approve });
  });

  r.post('/auth/device/token', async (req, res) => {
    const body = validate(z.object({ deviceCode: z.string().min(10).max(200) }), req.body);
    const dc = await DeviceCode.findOne({ deviceCodeHash: hashToken(body.deviceCode) });
    if (!dc || dc.status === 'used') throw badRequest('Unknown device code.', 'invalid_grant');
    if (dc.expiresAt < new Date()) throw badRequest('The code expired. Start the login again.', 'expired_token');
    if (dc.status === 'denied') throw badRequest('Login was denied in the dashboard.', 'access_denied');
    if (dc.status === 'pending') {
      const tooFast = dc.lastPolledAt && Date.now() - dc.lastPolledAt.getTime() < (dc.interval - 1) * 1000;
      await DeviceCode.updateOne({ _id: dc._id }, { lastPolledAt: new Date() });
      throw badRequest(tooFast ? 'Polling too fast.' : 'Waiting for approval in the dashboard.', tooFast ? 'slow_down' : 'authorization_pending');
    }
    // Approved: issue the personal token exactly once.
    const claimed = await DeviceCode.findOneAndUpdate({ _id: dc._id, status: 'approved' }, { status: 'used' });
    if (!claimed) throw badRequest('Unknown device code.', 'invalid_grant');
    const user = await User.findById(dc.userId);
    const { raw } = await issueToken(dc.userId, 'personal', dc.label);
    res.json({ token: raw, user: publicUser(user) });
  });

  // ---- Tokens (revoke CLI/extension logins and other sessions) ----
  r.get('/tokens', requireUser, async (req, res) => {
    const tokens = await Token.find({ userId: req.user._id, revokedAt: null, expiresAt: { $gt: new Date() } }).sort({ createdAt: -1 });
    res.json({ tokens: tokens.map((t) => ({ id: t._id, kind: t.kind, label: t.label, createdAt: t.createdAt, lastUsedAt: t.lastUsedAt, expiresAt: t.expiresAt, current: String(t._id) === String(req.token._id) })) });
  });

  r.delete('/tokens/:id', requireUser, async (req, res) => {
    const tokenId = validate(objectId, req.params.id);
    const result = await Token.updateOne({ _id: tokenId, userId: req.user._id, revokedAt: null }, { revokedAt: new Date() });
    if (!result.matchedCount) throw notFound('No such token.');
    res.json({ ok: true });
  });

  return r;
}

/** What clients may see about a user. @param {any} u */
export function publicUser(u) {
  if (!u) return null;
  return { id: String(u._id), name: u.name, email: u.email, avatarUrl: u.avatarUrl, teamId: u.teamId ? String(u.teamId) : null, role: u.role ?? null };
}
