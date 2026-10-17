// @vitest-environment node
// Extension sync against the real server app + in-memory MongoDB.
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { useDb, makeApp, signIn } from '../../server/test/helpers.js';
import { createExtensionSync, TOKEN_KEY, STATUS_KEY } from '../src/lib/syncEngine.js';
import { createSettingsStore } from '../src/lib/settings.js';
import { createLibrary, promptId } from '../src/lib/library.js';
import { createUsageStore } from '../src/lib/usageEstimates.js';
import { memoryArea } from './fakeChrome.js';

useDb();

function bridge(app) {
  return async (url, init = {}) => {
    const u = new URL(url);
    let req = request(app)[(init.method ?? 'GET').toLowerCase()](u.pathname + u.search);
    for (const [k, v] of Object.entries(init.headers ?? {})) req = req.set(k, v);
    const r = await (init.body ? req.send(JSON.parse(init.body)) : req);
    return new Response(r.text, { status: r.status, headers: { 'content-type': 'application/json' } });
  };
}

const SEED = { slug: 'local-seed', title: 'Local seed', category: 'dev', tags: [], description: '', scope: 'team', variables: [], steps: [], body: 'Seed prompt.' };
const TEAM = { slug: 'standup', title: 'Standup', category: 'team-ops', tags: [], description: '', scope: 'team', variables: [], steps: [], body: 'Write my standup.' };

async function setup(app, { signedInAs } = {}) {
  const area = memoryArea();
  const settings = createSettingsStore(area);
  await settings.update((s) => {
    s.serverUrl = 'http://api.test';
  });
  const library = createLibrary(area, { seeds: () => [SEED] });
  const usage = createUsageStore(area);
  const sync = createExtensionSync({ area, settings, library, usage, fetch: bridge(app) });
  if (signedInAs) {
    const start = await sync.startLogin();
    await sync.finishLogin(start, { sleep: async () => { await signedInAs.post('/api/v1/auth/device/approve', { userCode: start.userCode, approve: true }); } });
  }
  return { area, settings, library, usage, sync };
}

describe('extension sync', () => {
  it('does nothing without a server and sign-in', async () => {
    const app = makeApp();
    const area = memoryArea();
    const settings = createSettingsStore(area);
    const sync = createExtensionSync({ area, settings, library: createLibrary(area, { seeds: () => [] }), usage: createUsageStore(area), fetch: bridge(app) });
    expect(await sync.syncNow()).toEqual({ skipped: true, reason: 'local only' });
    await settings.update((s) => { s.serverUrl = 'http://api.test'; });
    expect(await sync.syncNow()).toEqual({ skipped: true, reason: 'not signed in' });
  });

  it('signs in with a device code, pulls team prompts, keeps local-only seeds, pushes colours and usage', async () => {
    const app = makeApp();
    const alice = await signIn(app, 'alice@example.com', 'Alice');
    await alice.post('/api/v1/teams', { name: 'Acme' });
    await alice.post('/api/v1/prompts', { prompt: TEAM });
    const ext = await setup(app, { signedInAs: alice });
    expect(await ext.sync.signedIn()).toBe(true);
    expect((await ext.area.get(TOKEN_KEY))[TOKEN_KEY]).toMatch(/^rlp_/);

    await ext.settings.update((s) => { s.colours.assignments = { 'project:p1': 'growth' }; });
    await ext.usage.add({ project: 'Launch', messages: 3, tokens: 900 });
    const r = await ext.sync.syncNow();
    expect(r).toMatchObject({ ok: true, pulled: 1, colours: 'pushed', usage: 1 });
    const slugs = (await ext.library.list()).map((p) => p.slug).sort();
    expect(slugs).toEqual(['local-seed', 'standup']); // seed stays local, team prompt pulled
    expect((await alice.get('/api/v1/colours')).body.assignments).toEqual({ 'project:p1': 'growth' });
    const usage = (await alice.get('/api/v1/usage?groupBy=user')).body.rows[0];
    expect(usage).toMatchObject({ userName: 'Alice', tokens: 900, messages: 3, sources: ['extension'] });
    expect((await ext.area.get(STATUS_KEY))[STATUS_KEY]).toMatchObject({ ok: true });
    // Seeds were never pushed to the team library.
    expect((await alice.get('/api/v1/prompts')).body.prompts.map((p) => p.slug)).toEqual(['standup']);
  });

  it('pushes local edits and deletions, and drops prompts deleted on the server', async () => {
    const app = makeApp();
    const alice = await signIn(app, 'alice@example.com', 'Alice');
    await alice.post('/api/v1/teams', { name: 'Acme' });
    const created = await alice.post('/api/v1/prompts', { prompt: TEAM });
    await alice.post('/api/v1/prompts', { prompt: { ...TEAM, slug: 'retro', title: 'Retro' } });
    const ext = await setup(app, { signedInAs: alice });
    await ext.sync.syncNow();

    // Edit a synced prompt locally -> pushed as a new version.
    const standup = (await ext.library.list()).find((p) => p.slug === 'standup');
    await ext.library.upsert({ ...standup, title: 'Daily standup' });
    // Edit a local-only seed -> now pushed too.
    const seed = (await ext.library.list()).find((p) => p.slug === 'local-seed');
    await ext.library.upsert({ ...seed, body: 'Edited seed.' });
    // Delete a synced prompt locally -> deleted on the server.
    await ext.library.remove(promptId((await ext.library.list()).find((p) => p.slug === 'retro')));
    const r = await ext.sync.syncNow();
    expect(r).toMatchObject({ ok: true, pushed: 2, deleted: 1 });
    const remote = (await alice.get('/api/v1/prompts')).body.prompts;
    expect(remote.map((p) => [p.slug, p.title, p.version]).sort()).toEqual([['local-seed', 'Local seed', 1], ['standup', 'Daily standup', 2]]);

    // Deleted on the server (e.g. from the dashboard) -> removed locally on the next sync.
    await alice.del(`/api/v1/prompts/${created.body.prompt.id}`);
    const r2 = await ext.sync.syncNow();
    expect(r2.removedLocally).toBe(1);
    expect((await ext.library.list()).map((p) => p.slug)).toEqual(['local-seed']);
  });

  it('pulls colours on a fresh browser, shares items, and forgets a revoked token', async () => {
    const app = makeApp();
    const alice = await signIn(app, 'alice@example.com', 'Alice');
    await alice.post('/api/v1/teams', { name: 'Acme' });
    await alice.put('/api/v1/colours', { preset: 'personal', presets: [], assignments: { 'chat:c1': 'ideas' } });
    const ext = await setup(app, { signedInAs: alice });
    expect((await ext.sync.syncNow()).colours).toBe('pulled');
    expect((await ext.settings.get()).colours).toEqual({ preset: 'personal', assignments: { 'chat:c1': 'ideas' } });

    await ext.sync.share({ kind: 'summary', title: 'Pricing summary', content: 'We priced three plans.' });
    expect((await alice.get('/api/v1/shared')).body.items[0]).toMatchObject({ kind: 'summary', title: 'Pricing summary' });

    const tokens = (await alice.get('/api/v1/tokens')).body.tokens;
    await alice.del(`/api/v1/tokens/${tokens.find((t) => t.label === 'ReSync extension').id}`);
    const r = await ext.sync.syncNow();
    expect(r.ok).toBe(false);
    expect(await ext.sync.signedIn()).toBe(false);
  });
});
