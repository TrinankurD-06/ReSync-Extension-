import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { useDb, makeApp, signIn, personalToken } from './helpers.js';
import { createSyncClient } from '@resync/shared/sync';

useDb();

const PROMPT = { slug: 'standup', title: 'Standup', category: 'team-ops', tags: ['daily'], description: 'Daily update', scope: 'team', variables: [{ name: 'yesterday' }], steps: [], body: 'Yesterday I {{yesterday}}.' };

async function twoInTeam(app) {
  const alice = await signIn(app, 'alice@example.com', 'Alice');
  await alice.post('/api/v1/teams', { name: 'Acme' });
  const inv = await alice.post('/api/v1/team/invites');
  const bob = await signIn(app, 'bob@example.com', 'Bob');
  await bob.post(`/api/v1/invites/${inv.body.token}/accept`);
  return { alice, bob };
}

/** A shared sync client (the one the CLI and extension use) talking to the app through supertest. */
function clientFor(app, token, client) {
  const fetch = async (url, init) => {
    const u = new URL(url);
    let req = request(app)[init.method.toLowerCase()](u.pathname + u.search);
    for (const [k, v] of Object.entries(init.headers ?? {})) req = req.set(k, v);
    const r = await (init.body ? req.send(JSON.parse(init.body)) : req);
    return new Response(r.text, { status: r.status, headers: { 'content-type': 'application/json' } });
  };
  return createSyncClient({ serverUrl: 'http://api.test', token, fetch, client });
}

describe('prompts', () => {
  it('team prompts are shared between teammates; personal ones are private', async () => {
    const app = makeApp();
    const { alice, bob } = await twoInTeam(app);
    const created = await alice.post('/api/v1/prompts', { prompt: PROMPT });
    expect(created.status).toBe(201);
    await alice.post('/api/v1/prompts', { prompt: { ...PROMPT, slug: 'mine', scope: 'personal' } });
    const bobList = (await bob.get('/api/v1/prompts')).body.prompts;
    expect(bobList.map((p) => [p.slug, p.scope])).toEqual([['standup', 'team']]);
    const lib = (await bob.get('/api/v1/prompts/library')).body;
    expect(lib.format).toBe('resync-prompt-library');
    expect(lib.prompts[0]).toEqual({ ...PROMPT });
  });

  it('validates with the shared schema', async () => {
    const app = makeApp();
    const a = await signIn(app, 'a@example.com');
    const r = await a.post('/api/v1/prompts', { prompt: { ...PROMPT, scope: 'personal', variables: [] } });
    expect(r.body.error.code).toBe('invalid_prompt');
    expect(r.body.error.message).toMatch(/not declared/);
    expect((await a.post('/api/v1/prompts', { prompt: PROMPT })).status).toBe(403); // team scope without a team
  });

  it('keeps version history, restores, and upserts by slug without duplicates', async () => {
    const app = makeApp();
    const { alice, bob } = await twoInTeam(app);
    const id = (await alice.post('/api/v1/prompts', { prompt: PROMPT })).body.prompt.id;
    await bob.put(`/api/v1/prompts/${id}`, { prompt: { ...PROMPT, title: 'Standup v2' } });
    const up = await alice.put('/api/v1/prompts/by-slug', { prompt: { ...PROMPT, title: 'Standup v3' } });
    expect(up.body.prompt.version).toBe(3);
    expect((await alice.put('/api/v1/prompts/by-slug', { prompt: { ...PROMPT, title: 'Standup v3' } })).body.unchanged).toBe(true);
    const h = (await alice.get(`/api/v1/prompts/${id}/versions`)).body;
    expect(h.current).toMatchObject({ version: 3, editedBy: 'Alice' });
    expect(h.versions.map((v) => [v.version, v.prompt.title, v.editedBy])).toEqual([[2, 'Standup v2', 'Bob'], [1, 'Standup', 'Alice']]);
    const restored = await alice.post(`/api/v1/prompts/${id}/restore`, { version: 1 });
    expect(restored.body.prompt).toMatchObject({ title: 'Standup', version: 4 });
    expect((await alice.get('/api/v1/prompts')).body.prompts).toHaveLength(1);
  });

  it('keeps chain settings (intake facts, success-criteria step) with a team chain', async () => {
    const app = makeApp();
    const { alice, bob } = await twoInTeam(app);
    const chain = { ...PROMPT, slug: 'launch', variables: [], body: '', steps: [{ text: 'Plan it.', waitFor: 'response', delaySeconds: 0 }], chain: { type: 'planning', intake: ['targetUser', 'teamMembers'], successCriteria: true } };
    const id = (await alice.post('/api/v1/prompts', { prompt: chain })).body.prompt.id;
    expect((await bob.get('/api/v1/prompts')).body.prompts.find((p) => p.slug === 'launch').chain).toEqual(chain.chain);
    expect((await alice.post('/api/v1/prompts', { prompt: { ...chain, slug: 'bad', chain: { intake: ['nope'] } } })).status).toBe(400);
    const { chain: _drop, ...plainPrompt } = chain;
    await alice.put(`/api/v1/prompts/${id}`, { prompt: plainPrompt });
    expect((await bob.get('/api/v1/prompts')).body.prompts.find((p) => p.slug === 'launch').chain).toBeUndefined();
  });

  it('moves between personal and team scopes', async () => {
    const app = makeApp();
    const { alice, bob } = await twoInTeam(app);
    const id = (await alice.post('/api/v1/prompts', { prompt: { ...PROMPT, scope: 'personal' } })).body.prompt.id;
    expect((await bob.get('/api/v1/prompts')).body.prompts).toHaveLength(0);
    expect((await alice.post(`/api/v1/prompts/${id}/move`, { scope: 'team' })).body.prompt.scope).toBe('team');
    expect((await bob.get('/api/v1/prompts')).body.prompts).toHaveLength(1);
    expect((await bob.post(`/api/v1/prompts/${id}/move`, { scope: 'personal' })).status).toBe(403); // not author/owner
    expect((await alice.post(`/api/v1/prompts/${id}/move`, { scope: 'personal' })).body.prompt.scope).toBe('personal');
    expect((await bob.get('/api/v1/prompts')).body.prompts).toHaveLength(0);
    expect((await bob.del(`/api/v1/prompts/${id}`)).status).toBe(404);
    expect((await alice.del(`/api/v1/prompts/${id}`)).status).toBe(200);
  });
});

describe('usage (numbers only)', () => {
  it('DoD: two users in one team share a team prompt, and both users usage from CLI and extension appears per user', async () => {
    const app = makeApp();
    const { alice, bob } = await twoInTeam(app);
    // Alice saves a team prompt from the CLI; Bob sees it through the same sync client.
    const aliceCli = clientFor(app, await personalToken(app, alice, 'resync CLI'), 'cli');
    const bobExt = clientFor(app, await personalToken(app, bob, 'ReSync extension'), 'extension');
    await aliceCli.upsertPrompt(PROMPT);
    expect((await bobExt.getLibrary()).prompts.map((p) => p.slug)).toEqual(['standup']);

    const day = '2026-10-17';
    await aliceCli.uploadUsage([
      { user: 'alice', project: 'resync', sessionId: 's1', date: day, source: 'plugin', inputTokens: 1000, outputTokens: 200, costUsd: 0.5 },
      { user: 'alice', project: 'resync', sessionId: 'q1', date: day, source: 'queue', inputTokens: 300, outputTokens: 50, costUsd: 0.1 },
    ]);
    const aliceExt = clientFor(app, await personalToken(app, alice, 'ReSync extension'), 'extension');
    await aliceExt.uploadUsage([{ user: 'alice', project: 'Launch', sessionId: `ext:${day}:Launch`, date: day, source: 'extension', messages: 4, estimatedTokens: 800 }]);
    await bobExt.uploadUsage([{ user: 'bob', project: 'Launch', sessionId: `ext:${day}:Launch`, date: day, source: 'extension', messages: 2, estimatedTokens: 400 }]);
    const bobCli = clientFor(app, await personalToken(app, bob, 'resync CLI'), 'cli');
    await bobCli.uploadUsage([{ user: 'bob', project: 'site', sessionId: 's9', date: day, source: 'plugin', inputTokens: 100, outputTokens: 10 }]);

    // Re-syncing the same records does not double count.
    await bobExt.uploadUsage([{ user: 'bob', project: 'Launch', sessionId: `ext:${day}:Launch`, date: day, source: 'extension', messages: 3, estimatedTokens: 600 }]);

    const byUser = (await alice.get('/api/v1/usage?groupBy=user')).body;
    expect(byUser.estimate).toBe(true);
    const rows = Object.fromEntries(byUser.rows.map((r) => [r.userName, r]));
    expect(rows.Alice).toMatchObject({ tokens: 1200 + 350 + 800, costUsd: 0.6, messages: 4, sources: ['extension', 'plugin', 'queue'] });
    expect(rows.Bob).toMatchObject({ tokens: 600 + 110, messages: 3, sources: ['extension', 'plugin'] });
    // Bob sees the same team view.
    expect((await bob.get('/api/v1/usage?groupBy=user')).body.rows).toHaveLength(2);
    const byProject = (await bob.get('/api/v1/usage?groupBy=project')).body.rows.map((r) => r.project).sort();
    expect(byProject).toEqual(['Launch', 'resync', 'site']);
    expect((await bob.get('/api/v1/usage?groupBy=day&from=2026-10-18')).body.rows).toEqual([]);
  });

  it('rejects anything that is not a number (no content can be stored)', async () => {
    const app = makeApp();
    const a = await signIn(app, 'a@example.com');
    const r = await a.post('/api/v1/usage', { records: [{ user: 'a', project: 'p', sessionId: 's', date: '2026-10-17', source: 'cli', prompt: 'secret text' }] });
    expect(r.body.error.code).toBe('validation_error');
    expect((await a.post('/api/v1/usage', { records: [] })).status).toBe(400);
  });

  it('usage recorded before joining a team becomes visible to the team; leaving hides it', async () => {
    const app = makeApp();
    const alice = await signIn(app, 'alice@example.com', 'Alice');
    await alice.post('/api/v1/teams', { name: 'Acme' });
    const bob = await signIn(app, 'bob@example.com', 'Bob');
    await bob.post('/api/v1/usage', { records: [{ user: 'bob', project: 'p', sessionId: 's', date: '2026-10-17', source: 'cli', inputTokens: 5 }] });
    const inv = await alice.post('/api/v1/team/invites');
    await bob.post(`/api/v1/invites/${inv.body.token}/accept`);
    expect((await alice.get('/api/v1/usage')).body.rows.map((r) => r.userName)).toEqual(['Bob']);
    await bob.post('/api/v1/team/leave');
    expect((await alice.get('/api/v1/usage')).body.rows).toEqual([]);
    expect((await bob.get('/api/v1/usage')).body.rows).toHaveLength(1); // still visible to Bob himself
  });
});

describe('queue reports, shared items, settings', () => {
  it('queue report summaries are visible to the team', async () => {
    const app = makeApp();
    const { alice, bob } = await twoInTeam(app);
    const report = { taskId: '20261017-0200-ab12', title: 'Fix flaky test', status: 'done', summary: 'Fixed the race.', branch: 'resync/20261017-0200-ab12', filesChanged: ['src/a.js'], testsRun: 'npm test (12 passed)', startedAt: '2026-10-17T02:00:00.000Z', finishedAt: '2026-10-17T02:10:00.000Z' };
    expect((await alice.post('/api/v1/queue-reports', report)).status).toBe(201);
    await alice.post('/api/v1/queue-reports', { ...report, summary: 'Updated.' }); // same task -> replaced
    const list = (await bob.get('/api/v1/queue-reports')).body.reports;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ userName: 'Alice', title: 'Fix flaky test', summary: 'Updated.', testsRun: 'npm test (12 passed)' });
  });

  it('shared passports: explicit share, team-visible, removable by author or owner', async () => {
    const app = makeApp();
    const { alice, bob } = await twoInTeam(app);
    const s = await bob.post('/api/v1/shared', { kind: 'passport', title: 'Pricing handoff', content: '# Context Passport\n## Goal\nShip pricing', project: 'site' });
    expect(s.status).toBe(201);
    const list = (await alice.get('/api/v1/shared')).body.items;
    expect(list[0]).toMatchObject({ title: 'Pricing handoff', userName: 'Bob', mine: false });
    expect(list[0]).not.toHaveProperty('content');
    expect((await alice.get(`/api/v1/shared/${s.body.id}`)).body.item.content).toContain('Ship pricing');
    expect((await alice.del(`/api/v1/shared/${s.body.id}`)).status).toBe(200); // owner may remove
    const solo = await signIn(app, 'solo@example.com');
    expect((await solo.post('/api/v1/shared', { kind: 'summary', title: 'x', content: 'y' })).status).toBe(403);
  });

  it('settings and colours sync; API keys are refused', async () => {
    const app = makeApp();
    const a = await signIn(app, 'a@example.com');
    expect((await a.put('/api/v1/me/settings', { settings: { feature: { summary: 'in-chat' } } })).status).toBe(200);
    expect((await a.get('/api/v1/me/settings')).body.settings).toEqual({ feature: { summary: 'in-chat' } });
    expect((await a.put('/api/v1/me/settings', { settings: { k: 'sk-ant-abcdefghijklmnop' } })).body.error.code).toBe('key_detected');
    const colours = { preset: 'startup', presets: [], assignments: { 'project:p1': 'growth' } };
    expect((await a.put('/api/v1/colours', colours)).status).toBe(200);
    expect((await a.get('/api/v1/colours')).body).toEqual(colours);
    expect((await a.put('/api/v1/colours', { assignments: { 'bad key': 'x' } })).status).toBe(400);
  });
});

describe('data controls', () => {
  it('exports everything as JSON without token secrets', async () => {
    const app = makeApp();
    const { alice } = await twoInTeam(app);
    await alice.post('/api/v1/prompts', { prompt: PROMPT });
    await alice.post('/api/v1/usage', { records: [{ user: 'a', project: 'p', sessionId: 's', date: '2026-10-17', source: 'cli', inputTokens: 5 }] });
    const t = await personalToken(app, alice);
    const r = await alice.get('/api/v1/me/export');
    expect(r.headers['content-disposition']).toMatch(/resync-export-/);
    expect(r.body).toMatchObject({ format: 'resync-export', user: { name: 'Alice' } });
    expect(r.body.prompts).toHaveLength(1);
    expect(r.body.usage).toHaveLength(1);
    expect(JSON.stringify(r.body)).not.toContain(t);
    expect(JSON.stringify(r.body)).not.toMatch(/"hash"/);
  });

  it('delete my data needs confirmation, refuses an owner with members, and removes everything', async () => {
    const app = makeApp();
    const { alice, bob } = await twoInTeam(app);
    await bob.post('/api/v1/prompts', { prompt: { ...PROMPT, scope: 'personal' } });
    await bob.post('/api/v1/usage', { records: [{ user: 'b', project: 'p', sessionId: 's', date: '2026-10-17', source: 'cli', inputTokens: 5 }] });
    expect((await bob.del('/api/v1/me', {})).status).toBe(400);
    expect((await alice.del('/api/v1/me', { confirm: 'DELETE' })).status).toBe(403);
    expect((await bob.del('/api/v1/me', { confirm: 'DELETE' })).status).toBe(200);
    expect((await bob.get('/api/v1/me')).status).toBe(401);
    expect((await alice.get('/api/v1/usage')).body.rows).toEqual([]);
    expect((await alice.get('/api/v1/team')).body.members).toHaveLength(1);
  });
});
