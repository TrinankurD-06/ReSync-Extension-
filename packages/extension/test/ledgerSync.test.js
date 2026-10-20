// @vitest-environment node
// Decision Ledger sync: off by default, needs the user's opt-in AND the team owner's, scrubs before upload, and a
// teammate's extension pulls the shared decisions. Real server app + in-memory MongoDB.
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { useDb, makeApp, signIn } from '../../server/test/helpers.js';
import { Decision } from '../../server/src/models/index.js';
import { createExtensionSync } from '../src/lib/syncEngine.js';
import { createSettingsStore } from '../src/lib/settings.js';
import { createLibrary } from '../src/lib/library.js';
import { createUsageStore } from '../src/lib/usageEstimates.js';
import { createLedger } from '../src/lib/ledger.js';
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

async function extensionFor(app, agent) {
  const area = memoryArea();
  const settings = createSettingsStore(area);
  await settings.update((s) => {
    s.serverUrl = 'http://api.test';
  });
  const ledger = createLedger(area);
  const sync = createExtensionSync({ area, settings, library: createLibrary(area, { seeds: () => [] }), usage: createUsageStore(area), ledger, fetch: bridge(app) });
  const start = await sync.startLogin();
  await sync.finishLogin(start, { sleep: async () => { await agent.post('/api/v1/auth/device/approve', { userCode: start.userCode, approve: true }); } });
  return { area, settings, ledger, sync };
}

async function team(app) {
  const alice = await signIn(app, 'alice@example.com', 'Alice');
  await alice.post('/api/v1/teams', { name: 'Acme' });
  const bob = await signIn(app, 'bob@example.com', 'Bob');
  const inv = await alice.post('/api/v1/team/invites');
  await bob.post(`/api/v1/invites/${inv.body.token}/accept`);
  return { alice, bob };
}

describe('decision ledger sync', () => {
  it('is off by default: nothing leaves the browser even when signed in and the team allows it', async () => {
    const app = makeApp();
    const { alice } = await team(app);
    await alice.patch('/api/v1/team/settings', { ledgerSync: true });
    const ext = await extensionFor(app, alice);
    expect((await ext.settings.get()).privacy.syncLedger).toBe(false);
    await ext.ledger.add({ text: 'Use PostgreSQL', reason: 'we know it', author: 'Alice' });
    const r = await ext.sync.syncNow();
    expect(r).toMatchObject({ ok: true, ledger: 'off', ledgerPushed: 0 });
    expect(await Decision.countDocuments()).toBe(0);
  });

  it('with the user on but the team off, still nothing is sent, and the summary says why', async () => {
    const app = makeApp();
    const { alice } = await team(app);
    const ext = await extensionFor(app, alice);
    await ext.settings.update((s) => { s.privacy.syncLedger = true; });
    await ext.ledger.add({ text: 'Use PostgreSQL' });
    const r = await ext.sync.syncNow();
    expect(r.ok).toBe(true);
    expect(r.ledger).toMatch(/off for your team/);
    expect(await Decision.countDocuments()).toBe(0);
  });

  it('with both on: scrubs secrets, emails and phone numbers before upload; a teammate pulls the decisions', async () => {
    const app = makeApp();
    const { alice, bob } = await team(app);
    const a = await extensionFor(app, alice);
    await a.settings.update((s) => { s.privacy.syncLedger = true; });
    expect(await a.sync.setTeamLedgerSync(true)).toEqual({ ok: true, ledgerSync: true }); // the owner, from the extension
    const local = await a.ledger.add({ text: 'Billing questions go to billing@acme.io', reason: 'call +91 98765 43210, key AIzaSyA1234567890abcdefghijk', author: 'Alice', project: 'Launch' });
    const r = await a.sync.syncNow();
    expect(r).toMatchObject({ ok: true, ledger: 'synced', ledgerPushed: 1 });
    const stored = await Decision.findOne({ clientId: local.id }).lean();
    expect(stored.text).toBe('Billing questions go to [removed email]');
    expect(stored.reason).toBe('call [removed phone], key [removed api key]');
    // The local copy is untouched (scrubbing is for the upload only), and nothing is pending.
    expect((await a.ledger.get(local.id)).text).toBe('Billing questions go to billing@acme.io');
    expect(await a.ledger.dirty()).toEqual([]);

    const b = await extensionFor(app, bob);
    await b.settings.update((s) => { s.privacy.syncLedger = true; });
    const rb = await b.sync.syncNow();
    expect(rb).toMatchObject({ ledger: 'synced', ledgerPulled: 1 });
    expect((await b.ledger.list())[0]).toMatchObject({ id: local.id, text: 'Billing questions go to [removed email]', author: 'Alice' });

    // Bob supersedes it; Alice gets both, linked.
    const next = await b.ledger.supersede(local.id, { text: 'Billing questions go to the support form', reason: 'one inbox', author: 'Bob' });
    await b.sync.syncNow();
    await a.sync.syncNow();
    const mine = await a.ledger.list();
    expect(mine.find((d) => d.id === local.id)).toMatchObject({ status: 'superseded', supersededBy: next.id });
    expect(mine.find((d) => d.id === next.id)).toMatchObject({ supersedes: local.id, author: 'Bob' });
  });
});
