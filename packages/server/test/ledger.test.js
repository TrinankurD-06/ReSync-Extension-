// Team Decision Ledger routes: off by default per team, owner-only switch, scrubbing on the server too, and the
// data controls (export, delete) cover decisions.
import { describe, it, expect } from 'vitest';
import { useDb, makeApp, signIn } from './helpers.js';
import { Decision } from '../src/models/index.js';

useDb();

const decision = (over = {}) => ({ id: 'd-1', text: 'Use PostgreSQL', reason: 'the team knows it', author: 'Alice', project: 'Launch', sourceChat: 'https://claude.ai/chat/c1', createdAt: '2026-10-21T10:00:00.000Z', updatedAt: '2026-10-21T10:00:00.000Z', status: 'active', supersededBy: null, supersedes: null, tags: ['postgresql'], confirmed: true, ...over });

async function team(app) {
  const alice = await signIn(app, 'alice@example.com', 'Alice');
  await alice.post('/api/v1/teams', { name: 'Acme' });
  const bob = await signIn(app, 'bob@example.com', 'Bob');
  const inv = await alice.post('/api/v1/team/invites');
  await bob.post(`/api/v1/invites/${inv.body.token}/accept`);
  return { alice, bob };
}

describe('decision ledger routes', () => {
  it('are off by default for a team; only the owner can allow them', async () => {
    const app = makeApp();
    const { alice, bob } = await team(app);
    expect((await alice.get('/api/v1/team')).body.team.ledgerSync).toBe(false);
    expect((await alice.get('/api/v1/me')).body.team.ledgerSync).toBe(false);
    const off = await alice.put('/api/v1/ledger', { decisions: [decision()] });
    expect(off.status).toBe(403);
    expect(off.body.error.code).toBe('ledger_sync_off');
    expect((await bob.get('/api/v1/ledger')).status).toBe(403);
    expect(await Decision.countDocuments()).toBe(0);

    expect((await bob.patch('/api/v1/team/settings', { ledgerSync: true })).status).toBe(403);
    expect((await alice.patch('/api/v1/team/settings', { ledgerSync: true })).body).toEqual({ ok: true, ledgerSync: true });
    expect((await bob.get('/api/v1/me')).body.team.ledgerSync).toBe(true);
    expect((await alice.patch('/api/v1/team/settings', { ledgerSync: true, extra: 1 })).status).toBe(400);
  });

  it('stores team decisions, scrubbing secrets again, and teammates read them', async () => {
    const app = makeApp();
    const { alice, bob } = await team(app);
    await alice.patch('/api/v1/team/settings', { ledgerSync: true });
    const r = await alice.put('/api/v1/ledger', { decisions: [decision({ reason: 'ask ops@acme.io for the key sk-ant-api03-abcdefghijklmnop' }), { id: 'bad' }] });
    expect(r.body).toEqual({ accepted: 1, rejected: 1 });
    const got = (await bob.get('/api/v1/ledger')).body.decisions;
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ id: 'd-1', text: 'Use PostgreSQL', reason: 'ask [removed email] for the key [removed api key]', status: 'active', createdAt: '2026-10-21T10:00:00.000Z' });
    // Re-sending the same id updates it (no duplicates); supersede links survive.
    await bob.put('/api/v1/ledger', { decisions: [decision({ status: 'superseded', supersededBy: 'd-2', updatedAt: '2026-10-22T00:00:00.000Z' }), decision({ id: 'd-2', text: 'Use MongoDB', supersedes: 'd-1' })] });
    const after = (await alice.get('/api/v1/ledger')).body.decisions;
    expect(after.map((d) => [d.id, d.status, d.supersededBy, d.supersedes]).sort()).toEqual([['d-1', 'superseded', 'd-2', null], ['d-2', 'active', null, 'd-1']]);
  });

  it('needs a team, and is part of export and delete', async () => {
    const app = makeApp();
    const solo = await signIn(app, 'solo@example.com', 'Solo');
    expect((await solo.get('/api/v1/ledger')).status).toBe(403);
    const { alice, bob } = await team(app);
    await alice.patch('/api/v1/team/settings', { ledgerSync: true });
    await bob.put('/api/v1/ledger', { decisions: [decision({ id: 'b-1', author: 'Bob' })] });
    expect((await bob.get('/api/v1/me/export')).body.decisions.map((d) => d.clientId)).toEqual(['b-1']);
    await bob.del('/api/v1/me', { confirm: 'DELETE' });
    expect(await Decision.countDocuments()).toBe(0);
    await alice.put('/api/v1/ledger', { decisions: [decision()] });
    await alice.del('/api/v1/team', { confirm: 'DELETE' });
    expect(await Decision.countDocuments()).toBe(0);
  });
});
