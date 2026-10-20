// Usage numbers, queue report summaries, explicitly shared passports/summaries, and data controls.
import { Router } from 'express';
import { z } from 'zod';
import { usageRecordSchema } from '@resync/shared/usage';
import { User, Team, Token, Prompt, PromptVersion, UsageRecord, QueueReport, SharedItem, Invite, DeviceCode, Decision } from '../models/index.js';
import { requireUser, requireTeam, SESSION_COOKIE } from '../lib/auth.js';
import { validate, notFound, forbidden, objectId } from '../lib/http.js';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function dataRoutes() {
  const r = Router();

  // ---- Usage (numbers only, all estimates) ----
  r.post('/usage', requireUser, async (req, res) => {
    // The shared schema is strict: any non-number field (e.g. text) is rejected.
    const { records } = validate(z.object({ records: z.array(usageRecordSchema).min(1).max(500) }), req.body);
    const ops = records.map((rec) => {
      const { isEstimate: _ignored, ...numbers } = rec;
      return {
        updateOne: {
          filter: { userId: req.user._id, source: rec.source, sessionId: rec.sessionId, date: rec.date },
          update: { $set: { ...numbers, userId: req.user._id, teamId: req.user.teamId ?? undefined } },
          upsert: true,
        },
      };
    });
    await UsageRecord.bulkWrite(ops, { ordered: false });
    res.json({ accepted: records.length });
  });

  /** Usage for the team (or just me when not in a team), grouped for the dashboard. */
  r.get('/usage', requireUser, async (req, res) => {
    const q = validate(
      z.object({
        from: z.string().regex(DATE).optional(),
        to: z.string().regex(DATE).optional(),
        groupBy: z.enum(['user', 'project', 'day', 'user-day', 'source']).default('user'),
      }),
      req.query,
    );
    const match = req.user.teamId ? { teamId: req.user.teamId } : { userId: req.user._id };
    if (q.from || q.to) match.date = { ...(q.from ? { $gte: q.from } : {}), ...(q.to ? { $lte: q.to } : {}) };
    const key = { user: { userId: '$userId' }, project: { project: '$project' }, day: { date: '$date' }, 'user-day': { userId: '$userId', date: '$date' }, source: { source: '$source' } }[q.groupBy];
    const tokenSum = {
      $cond: [
        { $gt: [{ $add: [{ $ifNull: ['$inputTokens', 0] }, { $ifNull: ['$outputTokens', 0] }, { $ifNull: ['$cacheReadTokens', 0] }, { $ifNull: ['$cacheCreationTokens', 0] }] }, 0] },
        { $add: [{ $ifNull: ['$inputTokens', 0] }, { $ifNull: ['$outputTokens', 0] }, { $ifNull: ['$cacheReadTokens', 0] }, { $ifNull: ['$cacheCreationTokens', 0] }] },
        { $ifNull: ['$estimatedTokens', 0] },
      ],
    };
    const rows = await UsageRecord.aggregate([
      { $match: match },
      {
        $group: {
          _id: key,
          tokens: { $sum: tokenSum },
          costUsd: { $sum: { $ifNull: ['$costUsd', 0] } },
          messages: { $sum: { $ifNull: ['$messages', 0] } },
          processedLow: { $sum: { $ifNull: ['$processedTokensLow', 0] } },
          processedHigh: { $sum: { $ifNull: ['$processedTokensHigh', 0] } },
          records: { $sum: 1 },
          sources: { $addToSet: '$source' },
        },
      },
      { $sort: { tokens: -1 } },
    ]);
    const users = new Map((await User.find({ _id: { $in: rows.map((x) => x._id.userId).filter(Boolean) } })).map((u) => [String(u._id), u.name]));
    res.json({
      estimate: true,
      groupBy: q.groupBy,
      rows: rows.map((x) => ({
        ...(x._id.userId ? { userId: String(x._id.userId), userName: users.get(String(x._id.userId)) ?? 'Former member' } : {}),
        ...(x._id.project ? { project: x._id.project } : {}),
        ...(x._id.date ? { date: x._id.date } : {}),
        ...(x._id.source ? { source: x._id.source } : {}),
        tokens: x.tokens, costUsd: Math.round(x.costUsd * 10_000) / 10_000, messages: x.messages, processedTokens: { low: x.processedLow, high: x.processedHigh }, records: x.records, sources: x.sources.sort(),
      })),
    });
  });

  // ---- Queue report summaries (optional upload) ----
  r.post('/queue-reports', requireUser, async (req, res) => {
    const body = validate(
      z.object({
        taskId: z.string().min(1).max(100), title: z.string().min(1).max(200), status: z.enum(['done', 'failed', 'waiting-for-reset']),
        summary: z.string().max(4000).default(''), branch: z.string().max(200).optional(), filesChanged: z.array(z.string().max(500)).max(500).default([]),
        testsRun: z.string().max(500).optional(), startedAt: z.string().datetime().optional(), finishedAt: z.string().datetime().optional(),
      }),
      req.body,
    );
    const doc = await QueueReport.findOneAndUpdate({ userId: req.user._id, taskId: body.taskId }, { ...body, userId: req.user._id, teamId: req.user.teamId ?? undefined }, { upsert: true, returnDocument: 'after' });
    res.status(201).json({ id: String(doc._id) });
  });

  r.get('/queue-reports', requireUser, async (req, res) => {
    const match = req.user.teamId ? { teamId: req.user.teamId } : { userId: req.user._id };
    const list = await QueueReport.find(match).sort({ finishedAt: -1, createdAt: -1 }).limit(200);
    const users = new Map((await User.find({ _id: { $in: list.map((x) => x.userId) } })).map((u) => [String(u._id), u.name]));
    res.json({ reports: list.map((x) => ({ id: String(x._id), userName: users.get(String(x.userId)) ?? 'Former member', taskId: x.taskId, title: x.title, status: x.status, summary: x.summary, branch: x.branch, filesChanged: x.filesChanged, testsRun: x.testsRun, startedAt: x.startedAt, finishedAt: x.finishedAt })) });
  });

  // ---- Shared passports / summaries / trees: only what a user explicitly shares ----
  r.post('/shared', requireTeam, async (req, res) => {
    const body = validate(z.object({ kind: z.enum(['passport', 'summary', 'tree']), title: z.string().trim().min(1).max(200), content: z.string().min(1).max(100_000), project: z.string().max(300).optional() }), req.body);
    const item = await SharedItem.create({ ...body, userId: req.user._id, teamId: req.user.teamId });
    res.status(201).json({ id: String(item._id) });
  });

  r.get('/shared', requireTeam, async (req, res) => {
    const list = await SharedItem.find({ teamId: req.user.teamId }).sort({ createdAt: -1 }).limit(200);
    const users = new Map((await User.find({ _id: { $in: list.map((x) => x.userId) } })).map((u) => [String(u._id), u.name]));
    res.json({ items: list.map((x) => ({ id: String(x._id), kind: x.kind, title: x.title, project: x.project, userName: users.get(String(x.userId)) ?? 'Former member', mine: String(x.userId) === String(req.user._id), createdAt: x.createdAt })) });
  });

  r.get('/shared/:id', requireTeam, async (req, res) => {
    const x = await SharedItem.findOne({ _id: validate(objectId, req.params.id), teamId: req.user.teamId });
    if (!x) throw notFound();
    res.json({ item: { id: String(x._id), kind: x.kind, title: x.title, content: x.content, project: x.project, createdAt: x.createdAt } });
  });

  r.delete('/shared/:id', requireTeam, async (req, res) => {
    const x = await SharedItem.findOne({ _id: validate(objectId, req.params.id), teamId: req.user.teamId });
    if (!x) throw notFound();
    if (String(x.userId) !== String(req.user._id) && req.user.role !== 'owner') throw forbidden('Only the person who shared it (or the owner) can remove it.');
    await SharedItem.deleteOne({ _id: x._id });
    res.json({ ok: true });
  });

  // ---- Data controls ----
  r.get('/me/export', requireUser, async (req, res) => {
    const uid = req.user._id;
    const [prompts, usage, reports, shared, tokens, team, decisions] = await Promise.all([
      Prompt.find({ $or: [{ ownerId: uid, scope: 'personal' }, ...(req.user.teamId ? [{ teamId: req.user.teamId, scope: 'team' }] : [])] }).lean(),
      UsageRecord.find({ userId: uid }).lean(),
      QueueReport.find({ userId: uid }).lean(),
      SharedItem.find({ userId: uid }).lean(),
      Token.find({ userId: uid, revokedAt: null }, { hash: 0 }).lean(),
      req.user.teamId ? Team.findById(req.user.teamId).lean() : null,
      Decision.find({ userId: uid }).lean(),
    ]);
    const versions = await PromptVersion.find({ promptId: { $in: prompts.map((p) => p._id) } }).lean();
    res.setHeader('content-disposition', `attachment; filename="resync-export-${new Date().toISOString().slice(0, 10)}.json"`);
    res.json({
      format: 'resync-export', version: 1, exportedAt: new Date().toISOString(),
      user: { id: String(uid), name: req.user.name, email: req.user.email, role: req.user.role, settings: req.user.settings, colours: req.user.colours },
      team, prompts, promptVersions: versions, usage, queueReports: reports, sharedItems: shared, decisions,
      tokens: tokens.map((t) => ({ kind: t.kind, label: t.label, createdAt: t.createdAt, lastUsedAt: t.lastUsedAt })),
    });
  });

  /** Delete my account and everything that belongs to me. Team prompts I wrote stay with the team. */
  r.delete('/me', requireUser, async (req, res) => {
    validate(z.object({ confirm: z.literal('DELETE') }), req.body);
    if (req.user.role === 'owner' && (await User.countDocuments({ teamId: req.user.teamId })) > 1) {
      throw forbidden('Transfer team ownership (or delete the team) before deleting your account.');
    }
    const uid = req.user._id;
    if (req.user.role === 'owner') {
      // Sole member and owner: the team goes too.
      const teamPrompts = await Prompt.find({ teamId: req.user.teamId, scope: 'team' }, { _id: 1 });
      await PromptVersion.deleteMany({ promptId: { $in: teamPrompts.map((p) => p._id) } });
      await Prompt.deleteMany({ teamId: req.user.teamId, scope: 'team' });
      await Invite.deleteMany({ teamId: req.user.teamId });
      await Decision.deleteMany({ teamId: req.user.teamId });
      await Team.deleteOne({ _id: req.user.teamId });
    }
    const personal = await Prompt.find({ ownerId: uid, scope: 'personal' }, { _id: 1 });
    await PromptVersion.deleteMany({ promptId: { $in: personal.map((p) => p._id) } });
    await Promise.all([
      Prompt.deleteMany({ ownerId: uid, scope: 'personal' }),
      UsageRecord.deleteMany({ userId: uid }),
      QueueReport.deleteMany({ userId: uid }),
      SharedItem.deleteMany({ userId: uid }),
      Decision.deleteMany({ userId: uid }),
      Token.deleteMany({ userId: uid }),
      DeviceCode.deleteMany({ userId: uid }),
    ]);
    await User.deleteOne({ _id: uid });
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.json({ ok: true });
  });

  return r;
}
