// Dashboard smoke test: two people form a team, share a team prompt, connect a CLI and an extension through
// the device-code flow, upload usage, and see it per user, plus the other pages render.
import { test, expect, request as pwRequest } from '@playwright/test';

const BASE = 'http://127.0.0.1:4319';

async function devSignIn(page, email) {
  await page.goto('/');
  await page.getByLabel('Email').fill(email);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText('Signed in as')).toBeVisible();
}

/** Emulate the CLI/extension device login: start, approve in the given page, then claim the token. */
async function connectDevice(page, label) {
  const api = await pwRequest.newContext({ baseURL: BASE });
  const start = await (await api.post('/api/v1/auth/device/code', { data: { label } })).json();
  await page.goto(`/device?code=${start.userCode}`);
  await page.getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByText(`Approved "${label}"`)).toBeVisible();
  const tok = await (await api.post('/api/v1/auth/device/token', { data: { deviceCode: start.deviceCode } })).json();
  await api.dispose();
  return tok.token;
}

async function uploadUsage(token, records) {
  const api = await pwRequest.newContext({ baseURL: BASE, extraHTTPHeaders: { authorization: `Bearer ${token}` } });
  const r = await api.post('/api/v1/usage', { data: { records } });
  expect(r.ok()).toBe(true);
  await api.dispose();
}

test('two teammates: team prompt, devices, usage per user, and every page renders', async ({ browser }) => {
  const day = new Date().toLocaleDateString('en-CA'); // local YYYY-MM-DD
  const aliceCtx = await browser.newContext();
  const bobCtx = await browser.newContext();
  const alice = await aliceCtx.newPage();
  const bob = await bobCtx.newPage();

  await test.step('Alice signs in and creates a team', async () => {
    await devSignIn(alice, 'alice@example.com');
    await alice.getByRole('link', { name: 'Team' }).click();
    await alice.getByLabel('Team name').fill('Acme');
    await alice.getByRole('button', { name: 'Create team' }).click();
    await expect(alice.getByRole('heading', { name: 'Acme: members' })).toBeVisible();
  });

  let inviteUrl;
  await test.step('Alice invites Bob; Bob joins with the link', async () => {
    await alice.getByRole('button', { name: 'Create invite link' }).click();
    inviteUrl = await alice.getByLabel('Invite link').innerText();
    expect(inviteUrl).toContain('/invite/inv_');
    await devSignIn(bob, 'bob@example.com');
    await bob.goto(new URL(inviteUrl).pathname);
    await bob.getByRole('button', { name: 'Join Acme' }).click();
    await expect(bob.getByRole('heading', { name: 'Acme: members' })).toBeVisible();
    await expect(bob.getByRole('cell', { name: 'alice', exact: true })).toBeVisible();
  });

  await test.step('Alice creates a team prompt; Bob sees it, edits it; history shows both', async () => {
    await alice.getByRole('link', { name: 'Prompts' }).click();
    await alice.getByRole('button', { name: 'New prompt' }).click();
    await alice.getByLabel('Title').fill('Weekly update');
    await alice.getByLabel('Category').fill('team-ops');
    await alice.getByLabel(/^Prompt text/).fill('Summarise this week for {{audience}}.');
    await alice.getByRole('button', { name: 'Save' }).click();
    await expect(alice.getByRole('cell', { name: /Weekly update/ })).toBeVisible();

    await bob.getByRole('link', { name: 'Prompts' }).click();
    await expect(bob.getByRole('cell', { name: /Weekly update/ })).toBeVisible();
    await bob.getByRole('button', { name: 'Edit' }).click();
    await bob.getByLabel('Title').fill('Weekly team update');
    await bob.getByRole('button', { name: 'Save' }).click();
    await expect(bob.getByRole('cell', { name: 'v2' })).toBeVisible();
    await bob.getByRole('button', { name: 'History' }).click();
    await expect(bob.getByLabel('Version history')).toContainText('v1');
    await expect(bob.getByLabel('Version history')).toContainText('alice');
  });

  await test.step('CLI and extension usage from both users appears per user, labelled as estimates', async () => {
    const aliceCli = await connectDevice(alice, 'resync CLI on Alice laptop');
    const bobExt = await connectDevice(bob, 'ReSync extension');
    await uploadUsage(aliceCli, [{ user: 'alice', project: 'resync', sessionId: 's1', date: day, source: 'plugin', inputTokens: 12000, outputTokens: 3000, costUsd: 0.75 }]);
    await uploadUsage(bobExt, [{ user: 'bob', project: 'Launch', sessionId: `ext:${day}:Launch`, date: day, source: 'extension', messages: 6, estimatedTokens: 2400 }]);

    await alice.getByRole('link', { name: 'Usage' }).click();
    const perUser = alice.getByRole('table', { name: 'Usage per user' });
    await expect(perUser.getByRole('row', { name: /alice.*Claude Code.*15\.0k/ })).toBeVisible();
    await expect(perUser.getByRole('row', { name: /bob.*Browser extension.*2400/ })).toBeVisible();
    await expect(alice.locator('.estimate').first()).toHaveText('estimate');
    await expect(alice.getByRole('table', { name: 'Usage per project' })).toContainText('Launch');
  });

  await test.step('tokens can be revoked on the Team page', async () => {
    await alice.getByRole('link', { name: 'Team' }).click();
    const row = alice.getByRole('row', { name: /resync CLI on Alice laptop/ });
    await expect(row).toBeVisible();
    await row.getByRole('button', { name: 'Revoke' }).click();
    await expect(alice.getByText('Token revoked.')).toBeVisible();
  });

  await test.step('queue reports, shared passports and data pages render', async () => {
    const token = await connectDevice(bob, 'resync CLI');
    const api = await pwRequest.newContext({ baseURL: BASE, extraHTTPHeaders: { authorization: `Bearer ${token}` } });
    await api.post('/api/v1/queue-reports', { data: { taskId: 't-1', title: 'Fix flaky test', status: 'done', summary: 'Fixed it.', branch: 'resync/t-1', filesChanged: ['src/a.js'], testsRun: 'npm test (5 passed)' } });
    await api.post('/api/v1/shared', { data: { kind: 'passport', title: 'Pricing handoff', content: '# Context Passport\n## Goal\nShip pricing' } });
    await api.dispose();

    await alice.getByRole('link', { name: 'Queue reports' }).click();
    await expect(alice.getByText('Fix flaky test')).toBeVisible();
    await expect(alice.getByText('npm test (5 passed)')).toBeVisible();

    await alice.getByRole('link', { name: 'Shared passports' }).click();
    await alice.getByRole('button', { name: 'Open' }).click();
    await expect(alice.getByLabel('Shared item')).toContainText('Ship pricing');

    await alice.getByRole('link', { name: 'Your data' }).click();
    await expect(alice.getByRole('button', { name: 'Export my data (JSON)' })).toBeVisible();
    const exp = await alice.request.get('/api/v1/me/export');
    expect((await exp.json()).format).toBe('resync-export');
  });

  await aliceCtx.close();
  await bobCtx.close();
});
