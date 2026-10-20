// Team Decision Ledger. Unlike usage numbers this is TEXT (decisions and reasons), so:
//  - it only works for teams whose owner turned ledger sync on (off by default; PATCH /team/settings);
//  - each user also opts in on their side (the clients' "Sync decisions" setting, off by default);
//  - clients scrub secrets, emails and phone numbers before upload, and the server scrubs again.
import { Router } from 'express';
import { z } from 'zod';
import { decisionSchema, scrubDecision } from '@resync/shared/ledger';
import { Team, Decision } from '../models/index.js';
import { requireTeam } from '../lib/auth.js';
import { validate, HttpError } from '../lib/http.js';

const syncOff = () => new HttpError(403, 'ledger_sync_off', 'Decision Ledger sync is off for your team. The team owner can turn it on in the dashboard (Team page).');

async function requireLedgerSync(req, _res, next) {
  try {
    const team = await Team.findById(req.user.teamId, { ledgerSync: 1 });
    next(team?.ledgerSync ? undefined : syncOff());
  } catch (e) {
    next(e);
  }
}

/** @param {any} d a stored Decision */
const toClient = (d) => ({
  id: d.clientId, text: d.text, reason: d.reason, author: d.author, project: d.project, sourceChat: d.sourceChat, status: d.status,
  supersededBy: d.supersededBy ?? null, supersedes: d.supersedes ?? null, tags: d.tags ?? [], confirmed: d.confirmed,
  createdAt: d.decidedAt ?? new Date(d.createdAt).toISOString(), updatedAt: d.clientUpdatedAt ?? new Date(d.updatedAt).toISOString(),
});

export function ledgerRoutes() {
  const r = Router();

  r.get('/ledger', requireTeam, requireLedgerSync, async (req, res) => {
    const list = await Decision.find({ teamId: req.user.teamId }).sort({ decidedAt: -1 }).limit(5000).lean();
    res.json({ decisions: list.map(toClient) });
  });

  r.put('/ledger', requireTeam, requireLedgerSync, async (req, res) => {
    const { decisions } = validate(z.object({ decisions: z.array(z.unknown()).max(500) }), req.body);
    const ops = [];
    let rejected = 0;
    for (const raw of decisions) {
      const parsed = decisionSchema.safeParse(raw);
      if (!parsed.success) {
        rejected++;
        continue;
      }
      const d = scrubDecision(parsed.data).decision; // defence in depth: clients scrub first
      ops.push({
        updateOne: {
          filter: { teamId: req.user.teamId, clientId: d.id },
          update: {
            $set: {
              userId: req.user._id, text: d.text, reason: d.reason, author: d.author, project: d.project, sourceChat: d.sourceChat, status: d.status,
              supersededBy: d.supersededBy, supersedes: d.supersedes, tags: d.tags, confirmed: d.confirmed, decidedAt: d.createdAt, clientUpdatedAt: d.updatedAt ?? d.createdAt,
            },
          },
          upsert: true,
        },
      });
    }
    if (ops.length) await Decision.bulkWrite(ops, { ordered: false });
    res.json({ accepted: ops.length, rejected });
  });

  return r;
}
