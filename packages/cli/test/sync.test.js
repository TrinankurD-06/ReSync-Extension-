// `resync login`, `resync sync`, `resync share`, `resync logout` against the real server app + in-memory MongoDB.
import { describe, it, expect, beforeEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { useDb, makeApp, signIn } from '../../server/test/helpers.js';
import { isolateHome } from './helpers.js';
import { buildProgram } from '../src/cli.js';
import { extendProgram } from '../src/commands.js';
import { setKeyStore, listKeys } from '../src/keys.js';
import { appendUsage } from '../src/usageLog.js';
import { reportSummary } from '../src/sync.js';

useDb();

/** fetch() that routes to the Express app in-process. */
function bridge(app) {
  return async (url, init = {}) => {
    const u = new URL(url);
    let req = request(app)[(init.method ?? 'GET').toLowerCase()](u.pathname + u.search);
    for (const [k, v] of Object.entries(init.headers ?? {})) req = req.set(k, v);
    const r = await (init.body ? req.send(JSON.parse(init.body)) : req);
    return new Response(r.text, { status: r.status, headers: { 'content-type': 'application/json' } });
  };
}

function memoryStore() {
  const m = new Map();
  return { m, available: async () => true, get: async (a) => m.get(a) ?? null, set: async (a, v) => void m.set(a, v), delete: async (a) => m.delete(a) };
}

let home;
let store;
beforeEach(async () => {
  home = await isolateHome();
  delete process.env.RESYNC_SERVER_URL; // the env var would override `resync config set serverUrl`
  store = memoryStore();
  setKeyStore(store);
});

function resync(app, extra = {}) {
  const lines = [];
  const io = { out: (s) => lines.push(s), fetch: bridge(app), ...extra };
  return {
    lines,
    run: (...args) => {
      const p = buildProgram({ out: io.out, err: io.out, extend: (prog) => extendProgram(prog, io) });
      p.exitOverride();
      return p.parseAsync(['node', 'resync', ...args]);
    },
  };
}

const TEAM_PROMPT = { slug: 'standup', title: 'Standup', category: 'team-ops', tags: [], description: 'Daily update', scope: 'team', variables: [], steps: [], body: 'Write my standup.' };

describe('resync login / sync / share / logout', () => {
  it('is local-only until a server is set', async () => {
    const app = makeApp();
    await expect(resync(app).run('sync')).rejects.toThrow(/local-only/);
  });

  it('logs in with a device code, syncs team prompts into /resync: commands, uploads usage, shares a passport', async () => {
    const app = makeApp();
    const alice = await signIn(app, 'alice@example.com', 'Alice');
    await alice.post('/api/v1/teams', { name: 'Acme' });
    await alice.post('/api/v1/prompts', { prompt: TEAM_PROMPT });

    // `resync login`: the "sleep" between polls is where Alice approves the code in the dashboard.
    const cli = resync(app, {
      sleep: async () => {
        const code = /code: ([A-Z0-9]{4}-[A-Z0-9]{4})/.exec(cli.lines.join('\n'))?.[1];
        if (code) await alice.post('/api/v1/auth/device/approve', { userCode: code, approve: true });
      },
    });
    await cli.run('config', 'set', 'serverUrl', 'http://api.test');
    await cli.run('login');
    expect(cli.lines.join('\n')).toMatch(/Signed in as Alice/);
    expect([...store.m.keys()]).toEqual(['resync-server-token']);
    expect(await listKeys()).toEqual([]); // the server token is not shown as an AI provider
    const cfgText = await fs.readFile(path.join(home, 'config.json'), 'utf8');
    expect(cfgText).not.toMatch(/rlp_/);

    await appendUsage({ user: 'alice', project: 'resync', sessionId: 's1', date: new Date().toLocaleDateString('en-CA'), source: 'plugin', inputTokens: 900, outputTokens: 100, costUsd: 0.2 });
    await cli.run('sync');
    const out = cli.lines.join('\n');
    expect(out).toMatch(/prompts: 1 \(1 team, 0 personal\)/);
    expect(out).toMatch(/usage records uploaded: 1/);
    await fs.access(path.join(home, 'library', 'team-ops', 'standup.md'));
    const cmds = await fs.readdir(path.join(home, 'claude-plugin', 'resync', 'commands'));
    expect(cmds).toContain('team-ops-standup.md');
    expect(cmds).toContain('passport.md');
    const usage = (await alice.get('/api/v1/usage?groupBy=user')).body.rows;
    expect(usage[0]).toMatchObject({ userName: 'Alice', tokens: 1000, costUsd: 0.2 });

    // Syncing again does not double count.
    await cli.run('sync');
    expect((await alice.get('/api/v1/usage?groupBy=user')).body.rows[0].tokens).toBe(1000);

    const passport = path.join(home, 'passports', 'p.md');
    await fs.mkdir(path.dirname(passport), { recursive: true });
    await fs.writeFile(passport, '# Context Passport: Pricing\n\n## Goal\n\nShip it\n');
    await cli.run('share', passport);
    const shared = (await alice.get('/api/v1/shared')).body.items;
    expect(shared[0]).toMatchObject({ kind: 'passport', title: 'Pricing', userName: 'Alice' });

    await cli.run('logout');
    expect(store.m.size).toBe(0);
    await expect(cli.run('sync')).rejects.toThrow(/Not signed in/);
  });

  it('uploads finished queue report summaries when opted in', async () => {
    const app = makeApp();
    const alice = await signIn(app, 'alice@example.com', 'Alice');
    const cli = resync(app, { skipPlugin: true, sleep: async () => {
      const code = /code: ([A-Z0-9]{4}-[A-Z0-9]{4})/.exec(cli.lines.join('\n'))?.[1];
      if (code) await alice.post('/api/v1/auth/device/approve', { userCode: code, approve: true });
    } });
    await cli.run('config', 'set', 'serverUrl', 'http://api.test');
    await cli.run('config', 'set', 'queue.uploadReports', 'true');
    await cli.run('login');
    const report = path.join(home, 'r.md');
    await fs.writeFile(report, '# ReSync queue report: t1\n\n## What was done\n\nFixed the flaky test.\n\n## Files changed\n\n- `src/a.js`\n\n## Tests run\n\nnpm test (5 passed)\n');
    await fs.writeFile(path.join(home, 'queue.json'), JSON.stringify({ version: 1, tasks: [
      { id: 't1', task: 'Fix flaky test', repo: home, tools: [], skipPermissions: false, runner: 'fake', status: 'done', createdAt: '2026-10-17T02:00:00.000Z', updatedAt: '2026-10-17T02:10:00.000Z', attempts: 1, branch: 'resync/t1', reportFile: report },
      { id: 't2', task: 'Still waiting', repo: home, tools: [], skipPermissions: false, runner: 'fake', status: 'waiting-for-reset', createdAt: '2026-10-17T02:00:00.000Z', updatedAt: '2026-10-17T02:00:00.000Z', attempts: 1 },
    ] }));
    await cli.run('sync');
    expect(cli.lines.join('\n')).toMatch(/queue reports uploaded: 1/);
    const reports = (await alice.get('/api/v1/queue-reports')).body.reports;
    expect(reports[0]).toMatchObject({ title: 'Fix flaky test', summary: 'Fixed the flaky test.', filesChanged: ['src/a.js'], testsRun: 'npm test (5 passed)', branch: 'resync/t1' });
    await cli.run('sync');
    expect(cli.lines.join('\n')).toMatch(/queue reports uploaded: 0/);
  });

  it('builds report summaries from report files', async () => {
    const s = await reportSummary({ id: 'x', task: 't', status: 'failed', lastError: 'Runner exited with code 2', createdAt: '2026-10-17T00:00:00.000Z', updatedAt: '2026-10-17T00:01:00.000Z' });
    expect(s).toMatchObject({ taskId: 'x', status: 'failed', summary: 'Runner exited with code 2', filesChanged: [] });
  });
});
