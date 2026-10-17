import { describe, it, expect } from 'vitest';
import { useDb, makeApp, signIn } from './helpers.js';
import { Invite } from '../src/models/index.js';

useDb();

async function teamOf(app) {
  const owner = await signIn(app, 'owner@example.com', 'Olivia');
  const created = await owner.post('/api/v1/teams', { name: 'Acme' });
  return { owner, team: created.body.team };
}

describe('teams (invite-only)', () => {
  it('owner creates a team, invites by link, a teammate joins once', async () => {
    const app = makeApp();
    const { owner, team } = await teamOf(app);
    expect(team.name).toBe('Acme');
    expect((await owner.get('/api/v1/me')).body).toMatchObject({ role: 'owner', team: { name: 'Acme' } });

    const inv = await owner.post('/api/v1/team/invites');
    expect(inv.status).toBe(201);
    expect(inv.body.url).toMatch(/^http:\/\/dash\.test\/invite\/inv_/);
    expect(JSON.stringify(await Invite.find().lean())).not.toContain(inv.body.token);

    const bob = await signIn(app, 'bob@example.com', 'Bob');
    expect((await bob.get(`/api/v1/invites/${inv.body.token}`)).body.team.name).toBe('Acme');
    expect((await bob.post(`/api/v1/invites/${inv.body.token}/accept`)).status).toBe(200);
    expect((await bob.get('/api/v1/me')).body).toMatchObject({ role: 'member', team: { name: 'Acme' } });

    const carol = await signIn(app, 'carol@example.com');
    expect((await carol.post(`/api/v1/invites/${inv.body.token}/accept`)).status).toBe(404); // single use

    const t = await owner.get('/api/v1/team');
    expect(t.body.members.map((m) => [m.name, m.role])).toEqual([['Olivia', 'owner'], ['Bob', 'member']]);
  });

  it('only the owner can invite, change roles and remove; members can leave', async () => {
    const app = makeApp();
    const { owner } = await teamOf(app);
    const inv = await owner.post('/api/v1/team/invites');
    const bob = await signIn(app, 'bob@example.com', 'Bob');
    await bob.post(`/api/v1/invites/${inv.body.token}/accept`);
    expect((await bob.post('/api/v1/team/invites')).status).toBe(403);

    const bobId = bob.user.id;
    expect((await owner.patch(`/api/v1/team/members/${bobId}`, { role: 'owner' })).status).toBe(200);
    expect((await owner.get('/api/v1/me')).body.role).toBe('member');
    expect((await bob.get('/api/v1/me')).body.role).toBe('owner');

    // Bob (now owner) removes Olivia.
    const olivia = (await bob.get('/api/v1/team')).body.members.find((m) => m.name === 'Olivia');
    expect((await bob.del(`/api/v1/team/members/${olivia.id}`)).status).toBe(200);
    expect((await owner.get('/api/v1/me')).body.team).toBeNull();
    expect((await bob.post('/api/v1/team/leave')).status).toBe(403); // owner can't just leave
  });

  it('invites can be listed, revoked and expire', async () => {
    const app = makeApp();
    const { owner } = await teamOf(app);
    const a = await owner.post('/api/v1/team/invites');
    const b = await owner.post('/api/v1/team/invites');
    expect((await owner.get('/api/v1/team/invites')).body.invites).toHaveLength(2);
    await owner.del(`/api/v1/team/invites/${a.body.id}`);
    await Invite.updateOne({ _id: b.body.id }, { expiresAt: new Date(Date.now() - 1000) });
    const bob = await signIn(app, 'bob@example.com');
    expect((await bob.post(`/api/v1/invites/${a.body.token}/accept`)).status).toBe(404);
    expect((await bob.post(`/api/v1/invites/${b.body.token}/accept`)).status).toBe(404);
  });

  it('cannot create or join a second team, and validates input', async () => {
    const app = makeApp();
    const { owner } = await teamOf(app);
    expect((await owner.post('/api/v1/teams', { name: 'Two' })).status).toBe(409);
    const solo = await signIn(app, 'solo@example.com');
    expect((await solo.post('/api/v1/teams', { name: '' })).body.error.code).toBe('validation_error');
    expect((await solo.get('/api/v1/team')).status).toBe(403);
    expect((await owner.patch('/api/v1/team/members/not-an-id', { role: 'member' })).body.error.code).toBe('validation_error');
  });

  it('owner deletes the team with confirmation', async () => {
    const app = makeApp();
    const { owner } = await teamOf(app);
    expect((await owner.del('/api/v1/team', {})).status).toBe(400);
    expect((await owner.del('/api/v1/team', { confirm: 'DELETE' })).status).toBe(200);
    expect((await owner.get('/api/v1/me')).body.team).toBeNull();
  });
});
