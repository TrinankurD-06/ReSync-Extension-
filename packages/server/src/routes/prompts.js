// Prompt libraries: personal and team scopes, version history, moving between scopes.
// Validation uses the same schema as the CLI and extension (@resync/shared/prompts).
import { Router } from 'express';
import { z } from 'zod';
import { validatePrompt, libraryToJson } from '@resync/shared/prompts';
import { Prompt, PromptVersion, User } from '../models/index.js';
import { requireUser } from '../lib/auth.js';
import { validate, badRequest, notFound, forbidden, conflict, objectId } from '../lib/http.js';

/** Prompt document -> shared Prompt shape. @param {any} p */
function plain(p) {
  const o = typeof p.toObject === 'function' ? p.toObject() : p;
  return {
    slug: o.slug, title: o.title, category: o.category, tags: o.tags ?? [], description: o.description ?? '', scope: o.scope,
    variables: (o.variables ?? []).map((v) => Object.fromEntries(Object.entries({ name: v.name, description: v.description, default: v.default }).filter(([, x]) => x != null))),
    steps: (o.steps ?? []).map((s) => ({ text: s.text, waitFor: s.waitFor, delaySeconds: s.delaySeconds })),
    body: o.body ?? '',
  };
}

/** @param {any} p */
function toClient(p) {
  return { id: String(p._id), ...plain(p), version: p.version, updatedAt: p.updatedAt, ownerId: String(p.ownerId) };
}

/** Validate the incoming prompt with the shared schema. */
function parseIncoming(body) {
  const { prompt } = validate(z.object({ prompt: z.record(z.string(), z.unknown()) }), body);
  const r = validatePrompt({ tags: [], description: '', variables: [], steps: [], body: '', scope: 'personal', ...prompt });
  if (!r.ok) throw badRequest(r.errors.join('; '), 'invalid_prompt');
  return r.prompt;
}

/** Ownership fields for a scope; team scope needs a team. */
function scopeOwner(user, scope) {
  if (scope === 'team') {
    if (!user.teamId) throw forbidden('Join a team to save team prompts.');
    return { teamId: user.teamId };
  }
  return { teamId: undefined };
}

/** Find a prompt the user may access (own personal prompts, or their team's prompts). */
async function findAccessible(user, id) {
  const p = await Prompt.findById(validate(objectId, id));
  if (!p) throw notFound('No such prompt.');
  const ok = p.scope === 'personal' ? String(p.ownerId) === String(user._id) : user.teamId && String(p.teamId) === String(user.teamId);
  if (!ok) throw notFound('No such prompt.');
  return p;
}

/** Snapshot the current version, then apply the update. */
async function saveVersion(p, next, userId) {
  await PromptVersion.create({ promptId: p._id, version: p.version, snapshot: plain(p), editedBy: p.updatedBy ?? p.ownerId });
  Object.assign(p, next, { version: p.version + 1, updatedBy: userId });
  await p.save();
  return p;
}

export function promptRoutes() {
  const r = Router();

  function visibleQuery(user, scope = 'all') {
    const personal = { scope: 'personal', ownerId: user._id };
    const team = user.teamId ? { scope: 'team', teamId: user.teamId } : null;
    if (scope === 'personal') return personal;
    if (scope === 'team') return team ?? { _id: null };
    return { $or: [personal, ...(team ? [team] : [])] };
  }

  r.get('/prompts', requireUser, async (req, res) => {
    const scope = validate(z.enum(['all', 'personal', 'team']).default('all'), req.query.scope);
    const list = await Prompt.find(visibleQuery(req.user, scope)).sort({ category: 1, title: 1 });
    res.json({ prompts: list.map(toClient) });
  });

  /** Portable library (used by `resync sync` and the extension). */
  r.get('/prompts/library', requireUser, async (req, res) => {
    const list = await Prompt.find(visibleQuery(req.user)).sort({ category: 1, slug: 1 });
    res.json(libraryToJson(list.map(plain)));
  });

  r.post('/prompts', requireUser, async (req, res) => {
    const prompt = parseIncoming(req.body);
    const owner = scopeOwner(req.user, prompt.scope);
    const p = await Prompt.create({ ...prompt, ...owner, ownerId: req.user._id, updatedBy: req.user._id });
    res.status(201).json({ prompt: toClient(p) });
  });

  /** Create or update by (scope, category, slug): what sync clients send. */
  r.put('/prompts/by-slug', requireUser, async (req, res) => {
    const prompt = parseIncoming(req.body);
    const owner = scopeOwner(req.user, prompt.scope);
    const where = prompt.scope === 'team' ? { scope: 'team', teamId: owner.teamId } : { scope: 'personal', ownerId: req.user._id };
    const existing = await Prompt.findOne({ ...where, category: prompt.category, slug: prompt.slug });
    if (!existing) {
      const p = await Prompt.create({ ...prompt, ...owner, ownerId: req.user._id, updatedBy: req.user._id });
      return res.status(201).json({ prompt: toClient(p), created: true });
    }
    if (JSON.stringify(plain(existing)) === JSON.stringify(plain(prompt))) return res.json({ prompt: toClient(existing), unchanged: true });
    res.json({ prompt: toClient(await saveVersion(existing, prompt, req.user._id)) });
  });

  r.put('/prompts/:id', requireUser, async (req, res) => {
    const p = await findAccessible(req.user, req.params.id);
    const prompt = parseIncoming(req.body);
    if (prompt.scope !== p.scope) throw badRequest('Use the move endpoint to change scope.');
    res.json({ prompt: toClient(await saveVersion(p, prompt, req.user._id)) });
  });

  r.get('/prompts/:id/versions', requireUser, async (req, res) => {
    const p = await findAccessible(req.user, req.params.id);
    const versions = await PromptVersion.find({ promptId: p._id }).sort({ version: -1 });
    const editors = new Map((await User.find({ _id: { $in: [...versions.map((v) => v.editedBy), p.updatedBy, p.ownerId].filter(Boolean) } })).map((u) => [String(u._id), u.name]));
    res.json({
      current: { version: p.version, updatedAt: p.updatedAt, editedBy: editors.get(String(p.updatedBy ?? p.ownerId)) },
      versions: versions.map((v) => ({ version: v.version, createdAt: v.createdAt, editedBy: editors.get(String(v.editedBy)) ?? null, prompt: plain(v.snapshot) })),
    });
  });

  r.post('/prompts/:id/restore', requireUser, async (req, res) => {
    const p = await findAccessible(req.user, req.params.id);
    const { version } = validate(z.object({ version: z.number().int().min(1) }), req.body);
    const v = await PromptVersion.findOne({ promptId: p._id, version });
    if (!v) throw notFound('No such version.');
    res.json({ prompt: toClient(await saveVersion(p, { ...plain(v.snapshot), scope: p.scope }, req.user._id)) });
  });

  r.post('/prompts/:id/move', requireUser, async (req, res) => {
    const p = await findAccessible(req.user, req.params.id);
    const { scope } = validate(z.object({ scope: z.enum(['personal', 'team']) }), req.body);
    if (scope === p.scope) return res.json({ prompt: toClient(p) });
    if (scope === 'personal' && String(p.ownerId) !== String(req.user._id) && req.user.role !== 'owner') {
      throw forbidden('Only the author or the team owner can move a team prompt out of the team.');
    }
    const owner = scopeOwner(req.user, scope);
    const where = scope === 'team' ? { scope, teamId: owner.teamId } : { scope, ownerId: req.user._id };
    if (await Prompt.exists({ ...where, category: p.category, slug: p.slug })) throw conflict(`A ${scope} prompt "${p.category}/${p.slug}" already exists.`);
    const next = { ...plain(p), scope };
    await saveVersion(p, { ...next, ownerId: scope === 'personal' ? req.user._id : p.ownerId, teamId: owner.teamId }, req.user._id);
    if (scope === 'personal') await Prompt.updateOne({ _id: p._id }, { $unset: { teamId: 1 } });
    res.json({ prompt: toClient(await Prompt.findById(p._id)) });
  });

  r.delete('/prompts/:id', requireUser, async (req, res) => {
    const p = await findAccessible(req.user, req.params.id);
    await PromptVersion.deleteMany({ promptId: p._id });
    await Prompt.deleteOne({ _id: p._id });
    res.json({ ok: true });
  });

  return r;
}
