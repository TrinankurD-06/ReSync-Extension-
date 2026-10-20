// The signed-in user: profile, synced (non-secret) settings and project colours.
import { Router } from 'express';
import { z } from 'zod';
import { User, Team } from '../models/index.js';
import { requireUser } from '../lib/auth.js';
import { validate, badRequest } from '../lib/http.js';
import { publicUser } from './auth.js';

const KEY_LIKE = /\b(sk-[A-Za-z0-9_-]{8,}|AIza[0-9A-Za-z_-]{20,})\b/;

/** @param {import('../config.js').ServerConfig} _cfg */
export function meRoutes(_cfg) {
  const r = Router();

  r.get('/me', requireUser, async (req, res) => {
    const team = req.user.teamId ? await Team.findById(req.user.teamId) : null;
    res.json({ ...publicUser(req.user), team: team ? { id: String(team._id), name: team.name, ledgerSync: Boolean(team.ledgerSync) } : null });
  });

  r.get('/me/settings', requireUser, (req, res) => res.json({ settings: req.user.settings ?? {} }));

  r.put('/me/settings', requireUser, async (req, res) => {
    const body = validate(z.object({ settings: z.record(z.string(), z.unknown()) }), req.body);
    const text = JSON.stringify(body.settings);
    if (text.length > 100_000) throw badRequest('Settings are too large.');
    // Keys never touch the server: refuse anything that looks like one.
    if (KEY_LIKE.test(text)) throw badRequest('Settings must not contain API keys.', 'key_detected');
    await User.updateOne({ _id: req.user._id }, { settings: body.settings });
    res.json({ settings: body.settings });
  });

  r.get('/colours', requireUser, (req, res) => res.json({ preset: req.user.colours?.preset ?? 'startup', presets: req.user.colours?.presets ?? [], assignments: req.user.colours?.assignments ?? {} }));

  r.put('/colours', requireUser, async (req, res) => {
    const body = validate(
      z.object({
        preset: z.string().max(40).optional(),
        presets: z.array(z.object({ id: z.string().max(40), label: z.string().max(60), colour: z.string().regex(/^#[0-9a-fA-F]{6}$/) })).max(50).default([]),
        assignments: z.record(z.string().regex(/^(project|chat):[A-Za-z0-9-]{1,100}$/), z.string().max(40)).default({}),
      }),
      req.body,
    );
    if (Object.keys(body.assignments).length > 2000) throw badRequest('Too many colour assignments.');
    await User.updateOne({ _id: req.user._id }, { colours: body });
    res.json(body);
  });

  return r;
}
