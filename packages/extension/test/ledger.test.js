// Decision Ledger in the extension: capture from a passport (dedupe, pending), manual edits, supersede links, the
// contradiction check with and without a BYOK model, dismissal feedback and the per-chat rate limit.
import { describe, it, expect } from 'vitest';
import { createLedger, checkMessage, MUTE_AFTER, RATE } from '../src/lib/ledger.js';
import { decisionInsertText } from '../src/lib/ledgerAlerts.js';
import { memoryArea } from './fakeChrome.js';

const PASSPORT = `## Meta
- Date: 2026-10-21
## Decisions made (and why)
- Use PostgreSQL for the main database — because the team already knows it
- Launch on 4 November because the conference starts that week
- Offer a free tier (assumed) — because competitors do
## Goal
Ship it.`;
const META = { author: 'Asha', project: 'Launch site', sourceChat: 'https://claude.ai/chat/c1' };
const CHAT = 'https://claude.ai/chat/c2';

async function seeded() {
  const ledger = createLedger(memoryArea());
  await ledger.addFromPassport(PASSPORT, META);
  return ledger;
}

describe('capture from a Context Passport', () => {
  it('adds the decisions; (assumed) ones are pending until confirmed', async () => {
    const ledger = createLedger(memoryArea());
    const r = await ledger.addFromPassport(PASSPORT, META);
    expect(r).toMatchObject({ pending: 1 });
    expect(r.added).toHaveLength(3);
    const list = await ledger.list();
    expect(list.map((d) => [d.text, d.status, d.author, d.project])).toEqual(expect.arrayContaining([
      ['Use PostgreSQL for the main database', 'active', 'Asha', 'Launch site'],
      ['Offer a free tier', 'pending', 'Asha', 'Launch site'],
    ]));
    const pending = list.find((d) => d.status === 'pending');
    const confirmed = await ledger.confirm(pending.id, { text: 'Offer a free tier for students', reason: 'growth' });
    expect(confirmed).toMatchObject({ status: 'active', confirmed: true, text: 'Offer a free tier for students', reason: 'growth' });
    expect(await ledger.dirty()).toContain(pending.id);
  });

  it('merges near-duplicates instead of adding them again', async () => {
    const ledger = await seeded();
    const r = await ledger.addFromPassport('## Decisions made (and why)\n- Use PostgreSQL for the main database (why: we know it)\n- Offer a free tier — because competitors do\n', META);
    expect(r.added).toHaveLength(0);
    expect(r.merged.map((d) => d.text).sort()).toEqual(['Offer a free tier', 'Use PostgreSQL for the main database']);
    expect(r.merged.find((d) => d.text === 'Offer a free tier')).toMatchObject({ status: 'active', confirmed: true }); // a confirmed copy confirms it
    expect(await ledger.list()).toHaveLength(3);
  });

  it('asks the model about borderline matches only when one is set up', async () => {
    const borderline = '## Decisions made (and why)\n- Store invoices in the main database\n';
    const local = await seeded();
    expect((await local.addFromPassport(borderline, META)).added).toHaveLength(1); // no model: kept separate

    const asked = [];
    const withModel = await seeded();
    const r = await withModel.addFromPassport(borderline, META, { confirmSame: async (a, b) => (asked.push([a.text, b.text]), true) });
    expect(asked).toEqual([['Use PostgreSQL for the main database', 'Store invoices in the main database']]);
    expect(r.merged).toHaveLength(1);
    const no = await seeded();
    expect((await no.addFromPassport(borderline, META, { confirmSame: async () => false })).added).toHaveLength(1);
  });
});

describe('manual edits and supersede', () => {
  it('adds, edits and supersedes with links both ways', async () => {
    const ledger = createLedger(memoryArea());
    const d = await ledger.add({ text: 'Host on Render', reason: 'free tier', author: 'Ben', project: 'Launch site' });
    expect(d).toMatchObject({ status: 'active', confirmed: true, tags: expect.arrayContaining(['render']) });
    await ledger.update(d.id, { reason: 'free tier and simple deploys' });
    const next = await ledger.supersede(d.id, { text: 'Host on Fly.io', reason: 'needs a region in India', author: 'Asha', sourceChat: CHAT });
    const list = await ledger.list();
    expect(list.find((x) => x.id === d.id)).toMatchObject({ status: 'superseded', supersededBy: next.id, reason: 'free tier and simple deploys' });
    expect(next).toMatchObject({ supersedes: d.id, project: 'Launch site', author: 'Asha', sourceChat: CHAT });
    await expect(ledger.supersede(d.id, { text: 'x' })).rejects.toThrow(/already superseded/);
    await expect(ledger.supersede(next.id, { text: ' ' })).rejects.toThrow(/Write the new decision/);
    expect((await ledger.dirty()).sort()).toEqual([d.id, next.id].sort());
  });

  it('"Insert into chat" text carries the decision, who and when, and the reason', async () => {
    const ledger = await seeded();
    const d = (await ledger.list()).find((x) => x.text.startsWith('Use PostgreSQL'));
    expect(decisionInsertText(d)).toBe(`Team decision (Asha, ${d.createdAt.slice(0, 10)}): Use PostgreSQL for the main database\nReason: the team already knows it`);
  });
});

describe('contradiction check', () => {
  const contradiction = { text: "Let's move the main database to MongoDB instead.", role: /** @type {const} */ ('user'), chat: CHAT, project: 'Launch site' };

  it('no candidates: no model call', async () => {
    const ledger = await seeded();
    let calls = 0;
    const r = await checkMessage({ ...contradiction, text: 'Fix the footer typo please' }, { ledger, modelEnabled: async () => true, run: async () => (calls++, { ok: true, text: '{}' }) });
    expect(r).toEqual({ alerts: [], usedModel: false });
    expect(calls).toBe(0);
  });

  it('without a BYOK key: shows "related", never "conflict", and calls nothing', async () => {
    const ledger = await seeded();
    let calls = 0;
    const r = await checkMessage(contradiction, { ledger, modelEnabled: async () => false, run: async () => (calls++, { ok: true, text: '' }) });
    expect(calls).toBe(0);
    expect(r.usedModel).toBe(false);
    expect(r.alerts.map((a) => [a.relation, a.decision.text])).toEqual([['related', 'Use PostgreSQL for the main database']]);
  });

  it('with a key: the model decides, in short JSON; only conflicts are shown', async () => {
    const ledger = await seeded();
    const reqs = [];
    const run = async (req) => {
      reqs.push(req);
      return { ok: true, text: '{"results":[{"id":"d1","relation":"conflict","why":"MongoDB replaces PostgreSQL."}]}' };
    };
    const r = await checkMessage(contradiction, { ledger, modelEnabled: async () => true, run });
    expect(reqs[0]).toMatchObject({ feature: 'ledger', maxTokens: 300 });
    expect(reqs[0].messages[0].content).toContain('[d1] Use PostgreSQL for the main database (reason: the team already knows it)');
    expect(r).toMatchObject({ usedModel: true, alerts: [{ relation: 'conflict', why: 'MongoDB replaces PostgreSQL.', decision: { text: 'Use PostgreSQL for the main database' } }] });

    const none = await checkMessage({ ...contradiction, chat: 'https://claude.ai/chat/other' }, { ledger, modelEnabled: async () => true, run: async () => ({ ok: true, text: '{"results":[{"id":"d1","relation":"related","why":""}]}' }) });
    expect(none).toEqual({ alerts: [], usedModel: true });
  });

  it('falls back to "related" when the model fails or answers badly', async () => {
    const ledger = await seeded();
    const failed = await checkMessage(contradiction, { ledger, modelEnabled: async () => true, run: async () => ({ ok: false, error: { message: 'Vault locked' } }) });
    expect(failed.alerts[0].relation).toBe('related');
    expect(failed.note).toMatch(/Vault locked/);
    const garbled = await checkMessage({ ...contradiction, chat: 'https://claude.ai/chat/z' }, { ledger, modelEnabled: async () => true, run: async () => ({ ok: true, text: 'Yes, it conflicts.' }) });
    expect(garbled.alerts[0].relation).toBe('related');
  });

  it('is rate limited per chat (model calls only)', async () => {
    const ledger = await seeded();
    let calls = 0;
    const run = async () => (calls++, { ok: true, text: '{"results":[{"id":"d1","relation":"conflict","why":"x"}]}' });
    await checkMessage(contradiction, { ledger, modelEnabled: async () => true, run });
    const second = await checkMessage(contradiction, { ledger, modelEnabled: async () => true, run });
    expect(calls).toBe(1);
    expect(second.alerts[0].relation).toBe('related');
    expect(second.note).toMatch(/check limit/);
    // Another chat has its own budget.
    await checkMessage({ ...contradiction, chat: 'https://claude.ai/chat/c3' }, { ledger, modelEnabled: async () => true, run });
    expect(calls).toBe(2);
    expect(RATE.minIntervalMs).toBeGreaterThan(0);
  });

  it('dismissals hide a decision in that chat, and mute it after repeated false positives', async () => {
    const ledger = await seeded();
    const id = (await checkMessage(contradiction, { ledger, modelEnabled: async () => false })).alerts[0].decision.id;
    expect(await ledger.dismiss(id, CHAT)).toEqual({ muted: false });
    expect((await checkMessage(contradiction, { ledger, modelEnabled: async () => false })).alerts).toEqual([]);
    expect((await checkMessage({ ...contradiction, chat: 'https://claude.ai/chat/c9' }, { ledger, modelEnabled: async () => false })).alerts).toHaveLength(1);
    for (let i = 1; i < MUTE_AFTER; i++) await ledger.dismiss(id, `https://claude.ai/chat/x${i}`);
    expect(await ledger.muted()).toEqual([id]);
    expect((await checkMessage({ ...contradiction, chat: 'https://claude.ai/chat/new' }, { ledger, modelEnabled: async () => false })).alerts).toEqual([]);
    await ledger.unmute(id);
    expect((await checkMessage({ ...contradiction, chat: 'https://claude.ai/chat/new' }, { ledger, modelEnabled: async () => false })).alerts).toHaveLength(1);
  });
});

describe('merging decisions pulled from the team', () => {
  it('adds new ones, takes newer copies, and keeps unpushed local edits', async () => {
    const ledger = await seeded();
    const [a, b] = await ledger.list();
    await ledger.clearDirty((await ledger.dirty()));
    await ledger.update(a.id, { reason: 'local edit' });
    const pulled = await ledger.mergeRemote([
      { ...a, reason: 'remote edit', updatedAt: '2099-01-01T00:00:00.000Z' },
      { ...b, reason: 'newer remote', updatedAt: '2099-01-01T00:00:00.000Z' },
      { ...b, id: 'd-remote', text: 'Hire a designer', createdAt: '2026-10-25T00:00:00.000Z' },
      { id: 'broken' },
    ]);
    expect(pulled).toBe(2);
    const list = await ledger.list();
    expect(list.find((d) => d.id === a.id).reason).toBe('local edit');
    expect(list.find((d) => d.id === b.id).reason).toBe('newer remote');
    expect(list.some((d) => d.id === 'd-remote')).toBe(true);
  });
});
