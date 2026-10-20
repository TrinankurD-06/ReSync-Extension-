// Teams: invite-only. An owner creates the team and shares invite links; roles are owner and member.
import { Router } from 'express';
import { z } from 'zod';
import { User, Team, Invite, Prompt, PromptVersion, UsageRecord, QueueReport, SharedItem, Decision } from '../models/index.js';
import { requireUser, requireTeam, requireOwner, randomToken, hashToken } from '../lib/auth.js';
import { validate, badRequest, notFound, conflict, forbidden, objectId } from '../lib/http.js';

const INVITE_TTL_MS = 7 * 86400_000;

/** @param {import('../config.js').ServerConfig} cfg */
export function teamRoutes(cfg) {
  const r = Router();

  r.post('/teams', requireUser, async (req, res) => {
    const body = validate(z.object({ name: z.string().trim().min(1).max(120) }), req.body);
    if (req.user.teamId) throw conflict('You are already in a team. Leave it first.');
    const team = await Team.create({ name: body.name, ownerId: req.user._id });
    await User.updateOne({ _id: req.user._id }, { teamId: team._id, role: 'owner' });
    res.status(201).json({ team: { id: String(team._id), name: team.name } });
  });

  r.get('/team', requireTeam, async (req, res) => {
    const team = await Team.findById(req.user.teamId);
    const members = await User.find({ teamId: req.user.teamId }).sort({ createdAt: 1 });
    res.json({
      team: { id: String(team._id), name: team.name, ownerId: String(team.ownerId), ledgerSync: Boolean(team.ledgerSync) },
      members: members.map((m) => ({ id: String(m._id), name: m.name, email: m.email, avatarUrl: m.avatarUrl, role: m.role })),
    });
  });

  /** Team settings (owner only). ledgerSync: allow members to sync Decision Ledger text to this server. */
  r.patch('/team/settings', requireOwner, async (req, res) => {
    const body = validate(z.object({ ledgerSync: z.boolean() }).strict(), req.body);
    await Team.updateOne({ _id: req.user.teamId }, { ledgerSync: body.ledgerSync });
    res.json({ ok: true, ledgerSync: body.ledgerSync });
  });

  // ---- Invites ----
  r.post('/team/invites', requireOwner, async (req, res) => {
    const raw = randomToken('inv');
    const invite = await Invite.create({ teamId: req.user.teamId, tokenHash: hashToken(raw), createdBy: req.user._id, expiresAt: new Date(Date.now() + INVITE_TTL_MS) });
    // The raw token is shown once; only its hash is stored.
    res.status(201).json({ id: String(invite._id), url: `${cfg.dashboardUrl}/invite/${raw}`, token: raw, expiresAt: invite.expiresAt });
  });

  r.get('/team/invites', requireOwner, async (req, res) => {
    const invites = await Invite.find({ teamId: req.user.teamId, usedAt: null, revokedAt: null, expiresAt: { $gt: new Date() } }).sort({ createdAt: -1 });
    res.json({ invites: invites.map((i) => ({ id: String(i._id), createdAt: i.createdAt, expiresAt: i.expiresAt })) });
  });

  r.delete('/team/invites/:id', requireOwner, async (req, res) => {
    const result = await Invite.updateOne({ _id: validate(objectId, req.params.id), teamId: req.user.teamId, usedAt: null }, { revokedAt: new Date() });
    if (!result.matchedCount) throw notFound('No such invite.');
    res.json({ ok: true });
  });

  async function findInvite(raw) {
    const invite = await Invite.findOne({ tokenHash: hashToken(String(raw)), usedAt: null, revokedAt: null, expiresAt: { $gt: new Date() } });
    if (!invite) throw notFound('This invite link is invalid, used or expired. Ask the team owner for a new one.');
    return invite;
  }

  /** Preview an invite (team name) before accepting. */
  r.get('/invites/:token', requireUser, async (req, res) => {
    const invite = await findInvite(req.params.token);
    const team = await Team.findById(invite.teamId);
    res.json({ team: { id: String(team._id), name: team.name } });
  });

  r.post('/invites/:token/accept', requireUser, async (req, res) => {
    if (req.user.teamId) throw conflict('You are already in a team. Leave it before joining another.');
    const invite = await findInvite(req.params.token);
    // Single use: claim atomically.
    const claimed = await Invite.findOneAndUpdate({ _id: invite._id, usedAt: null }, { usedAt: new Date(), usedBy: req.user._id });
    if (!claimed) throw notFound('This invite was just used.');
    await User.updateOne({ _id: req.user._id }, { teamId: invite.teamId, role: invite.role ?? 'member' });
    // Usage this user recorded before joining becomes visible to the team.
    await UsageRecord.updateMany({ userId: req.user._id }, { teamId: invite.teamId });
    const team = await Team.findById(invite.teamId);
    res.json({ team: { id: String(team._id), name: team.name } });
  });

  // ---- Members ----
  r.patch('/team/members/:userId', requireOwner, async (req, res) => {
    const userId = validate(objectId, req.params.userId);
    const body = validate(z.object({ role: z.enum(['owner', 'member']) }), req.body);
    const member = await User.findOne({ _id: userId, teamId: req.user.teamId });
    if (!member) throw notFound('No such member.');
    if (body.role === 'owner') {
      // Transfer ownership: one owner per team.
      await User.updateOne({ _id: req.user._id }, { role: 'member' });
      await Team.updateOne({ _id: req.user.teamId }, { ownerId: member._id });
    } else if (String(member._id) === String(req.user._id)) {
      throw badRequest('Transfer ownership to someone else instead.');
    }
    await User.updateOne({ _id: member._id }, { role: body.role });
    res.json({ ok: true });
  });

  r.delete('/team/members/:userId', requireOwner, async (req, res) => {
    const userId = validate(objectId, req.params.userId);
    if (String(userId) === String(req.user._id)) throw badRequest('Owners cannot remove themselves. Transfer ownership or delete the team.');
    const result = await User.updateOne({ _id: userId, teamId: req.user.teamId }, { $unset: { teamId: 1, role: 1 } });
    if (!result.matchedCount) throw notFound('No such member.');
    await detachFromTeam(userId);
    res.json({ ok: true });
  });

  r.post('/team/leave', requireTeam, async (req, res) => {
    if (req.user.role === 'owner') throw forbidden('Owners must transfer ownership or delete the team before leaving.');
    await User.updateOne({ _id: req.user._id }, { $unset: { teamId: 1, role: 1 } });
    await detachFromTeam(req.user._id);
    res.json({ ok: true });
  });

  /** Data control: delete the team and everything shared in it. Members keep their accounts and personal data. */
  r.delete('/team', requireOwner, async (req, res) => {
    validate(z.object({ confirm: z.literal('DELETE') }), req.body);
    const teamId = req.user.teamId;
    const teamPrompts = await Prompt.find({ teamId, scope: 'team' }, { _id: 1 });
    await PromptVersion.deleteMany({ promptId: { $in: teamPrompts.map((p) => p._id) } });
    await Prompt.deleteMany({ teamId, scope: 'team' });
    await SharedItem.deleteMany({ teamId });
    await Decision.deleteMany({ teamId });
    await QueueReport.updateMany({ teamId }, { $unset: { teamId: 1 } });
    await UsageRecord.updateMany({ teamId }, { $unset: { teamId: 1 } });
    await Invite.deleteMany({ teamId });
    await User.updateMany({ teamId }, { $unset: { teamId: 1, role: 1 } });
    await Team.deleteOne({ _id: teamId });
    res.json({ ok: true });
  });

  return r;
}

/** When someone leaves a team, their records stop being visible to it. */
async function detachFromTeam(userId) {
  await UsageRecord.updateMany({ userId }, { $unset: { teamId: 1 } });
  await QueueReport.updateMany({ userId }, { $unset: { teamId: 1 } });
  await SharedItem.deleteMany({ userId });
}
