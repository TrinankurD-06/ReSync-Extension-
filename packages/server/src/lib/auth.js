// Tokens and authentication. Every login (dashboard session or CLI/extension personal token) is a random
// token stored only as a SHA-256 hash, so it can be listed and revoked. The raw value is shown once.
import crypto from 'node:crypto';
import { Token } from '../models/index.js';
import { unauthorized, forbidden } from './http.js';

export const SESSION_COOKIE = 'resync_session';
export const SESSION_TTL_MS = 14 * 86400_000;
export const PERSONAL_TTL_MS = 365 * 86400_000;

/** @param {string} prefix */
export function randomToken(prefix) {
  return `${prefix}_${crypto.randomBytes(32).toString('base64url')}`;
}

/** @param {string} raw */
export function hashToken(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

/**
 * Issue a token for a user. Returns the raw value (show once) and the stored document.
 * @param {import('mongoose').Types.ObjectId | string} userId
 * @param {'session' | 'personal'} kind
 * @param {string} [label]
 */
export async function issueToken(userId, kind, label = '') {
  const raw = randomToken(kind === 'session' ? 'rls' : 'rlp');
  const doc = await Token.create({
    userId, kind, label: label.slice(0, 120), hash: hashToken(raw),
    expiresAt: new Date(Date.now() + (kind === 'session' ? SESSION_TTL_MS : PERSONAL_TTL_MS)),
  });
  return { raw, doc };
}

/** Cookie options for the dashboard session. @param {import('../config.js').ServerConfig} cfg */
export function sessionCookieOptions(cfg) {
  return { httpOnly: true, sameSite: /** @type {const} */ ('lax'), secure: cfg.production, maxAge: SESSION_TTL_MS, path: '/' };
}

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Attach req.user / req.token when a valid token is presented. Does not reject anonymous requests.
 * @param {{ User: import('mongoose').Model<any> }} models
 */
export function authenticate(models) {
  return async (req, _res, next) => {
    const header = req.get('authorization') ?? '';
    const bearer = /^Bearer\s+(\S+)$/i.exec(header)?.[1];
    const raw = bearer ?? req.cookies?.[SESSION_COOKIE];
    if (!raw) return next();
    const token = await Token.findOne({ hash: hashToken(raw), revokedAt: null, expiresAt: { $gt: new Date() } });
    if (!token) return next();
    const user = await models.User.findById(token.userId);
    if (!user) return next();
    // Cookie-authenticated writes must carry a custom header: cross-site forms cannot set it (CSRF defence).
    if (!bearer && !SAFE.has(req.method) && !req.get('x-resync-csrf')) return next(forbidden('Missing x-resync-csrf header.'));
    req.user = user;
    req.token = token;
    if (!token.lastUsedAt || Date.now() - token.lastUsedAt.getTime() > 5 * 60_000) {
      Token.updateOne({ _id: token._id }, { lastUsedAt: new Date() }).catch(() => {});
    }
    next();
  };
}

/** Reject requests without a signed-in user. */
export function requireUser(req, _res, next) {
  if (!req.user) return next(unauthorized());
  next();
}

/** Reject users who are not in a team. */
export function requireTeam(req, _res, next) {
  if (!req.user) return next(unauthorized());
  if (!req.user.teamId) return next(forbidden('Join or create a team first.'));
  next();
}

/** Reject non-owners. */
export function requireOwner(req, _res, next) {
  if (!req.user?.teamId || req.user.role !== 'owner') return next(forbidden('Only the team owner can do this.'));
  next();
}

/** Human-friendly device user code, e.g. "KQTD-W7MX" (no 0/O/1/I to avoid confusion). */
export function userCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(8);
  const chars = [...bytes].map((b) => alphabet[b % alphabet.length]);
  return `${chars.slice(0, 4).join('')}-${chars.slice(4).join('')}`;
}

/** PKCE verifier + S256 challenge. */
export function pkce() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}
