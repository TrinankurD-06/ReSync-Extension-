// Definition of done (sync): two accounts in one team share a team prompt, and both users' usage, from the real
// `resync` CLI and the real extension sync engine, appears per user on the dashboard. Real server over HTTP.
import { test, expect } from '@playwright/test';
import { mkdtempSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BASE = 'http://127.0.0.1:4319';

async function devSignIn(page, email) {
  await page.goto('/');
  await page.getByLabel('Email').fill(email);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText('Signed in as')).toBeVisible();
}

/** Approve a device code in the user's own dashboard session, as a person would. */
async function approve(page, code) {
  await page.goto(`/device?code=${code}`);
  await page.getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByText(/Approved/)).toBeVisible();
}

test('team prompt and per-user usage across the CLI, the extension and the dashboard', async ({ browser }) => {
  // CLI state in a temp folder; keys in memory (never the real OS keychain).
  process.env.RESYNC_HOME = mkdtempSync(path.join(os.tmpdir(), 'resync-full-'));
  process.env.RESYNC_USER = 'alice';
  delete process.env.RESYNC_SERVER_URL;
  const { buildProgram } = await import('../../cli/src/cli.js');
  const { extendProgram } = await import('../../cli/src/commands.js');
  const { setKeyStore } = await import('../../cli/src/keys.js');
  const { appendUsage } = await import('../../cli/src/usageLog.js');
  const mem = new Map();
  setKeyStore({ available: async () => true, get: async (a) => mem.get(a) ?? null, set: async (a, v) => void mem.set(a, v), delete: async (a) => mem.delete(a) });

  const alice = await (await browser.newContext()).newPage();
  const bob = await (await browser.newContext()).newPage();
  await devSignIn(alice, 'alice@example.com');
  await alice.getByRole('link', { name: 'Team' }).click();
  await alice.getByLabel('Team name').fill('Acme');
  await alice.getByRole('button', { name: 'Create team' }).click();
  await alice.getByRole('button', { name: 'Create invite link' }).click();
  const invite = await alice.getByLabel('Invite link').innerText();

  // Alice writes a team prompt in the dashboard.
  await alice.getByRole('link', { name: 'Prompts' }).click();
  await alice.getByRole('button', { name: 'New prompt' }).click();
  await alice.getByLabel('Title').fill('Release notes');
  await alice.getByLabel('Category').fill('team-ops');
  await alice.getByLabel(/^Prompt text/).fill('Write release notes for {{version}}.');
  await alice.getByRole('button', { name: 'Save' }).click();

  // ---- Alice: the real resync CLI ----
  const lines = [];
  let approved = false;
  const io = {
    out: (s) => lines.push(s),
    skipPlugin: false,
    sleep: async () => {
      const code = /code: ([A-Z0-9]{4}-[A-Z0-9]{4})/.exec(lines.join('\n'))?.[1];
      if (code && !approved) {
        await approve(alice, code);
        approved = true;
      }
    },
  };
  const resync = async (...args) => {
    const p = buildProgram({ out: io.out, err: io.out, extend: (prog) => extendProgram(prog, io) });
    p.exitOverride();
    await p.parseAsync(['node', 'resync', ...args]);
  };
  await resync('config', 'set', 'serverUrl', BASE);
  await resync('login');
  const today = new Date().toLocaleDateString('en-CA');
  await appendUsage({ user: 'alice', project: 'resync', sessionId: 'cc-1', date: today, source: 'plugin', inputTokens: 20000, outputTokens: 5000, costUsd: 1.25 });
  await resync('sync');
  expect(lines.join('\n')).toMatch(/prompts: 1 \(1 team, 0 personal\)/);
  expect(lines.join('\n')).toMatch(/usage records uploaded: 1/);
  expect(existsSync(path.join(process.env.RESYNC_HOME, 'claude-plugin', 'resync', 'commands', 'team-ops-release-notes.md'))).toBe(true);

  // ---- Bob: joins, then the real extension sync engine ----
  await devSignIn(bob, 'bob@example.com');
  await bob.goto(new URL(invite).pathname);
  await bob.getByRole('button', { name: 'Join Acme' }).click();
  await expect(bob.getByRole('heading', { name: 'Acme: members' })).toBeVisible();

  const { createExtensionSync } = await import('../../extension/src/lib/syncEngine.js');
  const { createSettingsStore } = await import('../../extension/src/lib/settings.js');
  const { createLibrary } = await import('../../extension/src/lib/library.js');
  const { createUsageStore } = await import('../../extension/src/lib/usageEstimates.js');
  const { memoryArea } = await import('../../extension/test/fakeChrome.js');
  const area = memoryArea();
  const settings = createSettingsStore(area);
  await settings.update((s) => { s.serverUrl = BASE; });
  const library = createLibrary(area, { seeds: () => [] });
  const usage = createUsageStore(area);
  const ext = createExtensionSync({ area, settings, library, usage });
  const start = await ext.startLogin();
  await approve(bob, start.userCode);
  await ext.finishLogin(start, { sleep: async () => {} });
  await usage.add({ project: 'Launch', messages: 7, tokens: 2800 });
  const r = await ext.syncNow();
  expect(r).toMatchObject({ ok: true, pulled: 1, usage: 1 });
  expect((await library.list()).map((p) => p.title)).toEqual(['Release notes']); // the shared team prompt

  // ---- The dashboard shows both users' usage per user, with their sources ----
  await alice.getByRole('link', { name: 'Usage' }).click();
  const perUser = alice.getByRole('table', { name: 'Usage per user' });
  await expect(perUser.getByRole('row', { name: /alice.*Claude Code.*25\.0k.*\$1\.25/ })).toBeVisible();
  await expect(perUser.getByRole('row', { name: /bob.*Browser extension.*2800.*7/ })).toBeVisible();
  await expect(alice.getByText('These are estimates of what was used')).toBeVisible();

  // README screenshots (only with RESYNC_SCREENSHOTS=1).
  if (process.env.RESYNC_SCREENSHOTS === '1') {
    const out = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:)/, '')), '../../../docs/screenshots');
    await alice.setViewportSize({ width: 1180, height: 760 });
    await alice.screenshot({ path: path.join(out, 'dashboard-usage.png') });
    await alice.getByRole('link', { name: 'Prompts' }).click();
    await expect(alice.getByRole('cell', { name: /Release notes/ })).toBeVisible();
    await alice.screenshot({ path: path.join(out, 'dashboard-prompts.png') });
  }
});
