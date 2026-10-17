// End-to-end: the built extension in Chromium against a mock claude.ai page (e2e/mock-claude.html) and a
// mock OpenAI-compatible provider. Covers the extension items of the definition of done.
// Run: npm run test:e2e -w @resync/extension   (builds with `--mode e2e`, then runs Playwright)
import { test, expect, chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { readFileSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(here, '../dist-e2e'); // test build (npm run build:e2e), never the real dist/
const MOCK_PAGE = readFileSync(path.join(here, 'mock-claude.html'), 'utf8');
const SECTIONS = ['Goal', 'Current state', 'Decisions made (and why)', 'Open questions', 'Dead ends', 'Next 3 steps', 'Key files'];

/** Mock OpenAI-compatible provider (streams SSE like Ollama/OpenAI). */
function startProvider() {
  const requests = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.url.endsWith('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ data: [{ id: 'mock-model' }] }));
      }
      const json = JSON.parse(body || '{}');
      requests.push(json);
      // Look only at the instructions after the transcript (the transcript itself may mention other features).
      const prompt = (json.messages?.at(-1)?.content ?? '').split('</transcript>').pop();
      const text = prompt.includes('Context Passport')
        ? SECTIONS.map((s) => `## ${s}\n${s} (from the API).`).join('\n\n')
        : prompt.includes('topic tree')
          ? '```json\n' + JSON.stringify({ topic: 'API tree', turnRange: [1, 2], children: [{ topic: 'Plans', turnRange: [1, 2], children: [] }] }) + '\n```'
          : 'ok';
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const chunk of text.match(/[\s\S]{1,30}/g)) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chunk } }] })}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, requests, port: server.address().port })));
}

test('ReSync extension end to end', async () => {
  const provider = await startProvider();
  const context = await chromium.launchPersistentContext(mkdtempSync(path.join(os.tmpdir(), 'resync-e2e-')), {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`],
  });
  try {
    await context.route('https://claude.ai/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: MOCK_PAGE }));
    let [worker] = context.serviceWorkers();
    worker ??= await context.waitForEvent('serviceworker');
    const extId = new URL(worker.url()).host;

    const claude = await context.newPage();
    await claude.goto('https://claude.ai/chat/c1');
    await expect(claude.locator('.ProseMirror')).toBeVisible();

    const panel = await context.newPage();
    await panel.goto(`chrome-extension://${extId}/sidepanel.html`);
    const tabId = await panel.evaluate(async () => (await chrome.tabs.query({ url: 'https://claude.ai/*' }))[0].id);
    await panel.goto(`chrome-extension://${extId}/sidepanel.html?tab=${tabId}`);
    panel.on('dialog', (d) => d.accept()); // the per-feature "API mode sends this conversation" confirmation
    const tab = (name) => panel.getByRole('tab', { name }).click();

    // No selector-health banner on a page where everything is found.
    await expect(claude.locator('#resync-health-banner')).toHaveCount(0);

    await test.step('project colours show', async () => {
      await tab('Colours');
      await panel.getByRole('button', { name: 'Refresh' }).click();
      await panel.getByLabel('Colour for Launch site').selectOption('growth');
      await expect(claude.locator('nav a[href="/project/p1"]')).toHaveAttribute('data-resync-colour', 'growth');
    });

    await test.step('a prompt inserts with variables filled', async () => {
      await tab('Prompts');
      await panel.getByLabel('Search prompts').fill('explain concept');
      await panel.getByRole('button', { name: 'Insert', exact: true }).first().click();
      await panel.getByLabel('concept').fill('recursion');
      await panel.getByRole('button', { name: 'Insert', exact: true }).click();
      await expect(claude.locator('.ProseMirror')).toContainText('Explain recursion three times');
      await claude.evaluate(() => (document.querySelector('.ProseMirror').innerHTML = ''));
    });

    await test.step(';; quick picker inserts in the page', async () => {
      await claude.locator('.ProseMirror').click();
      await claude.keyboard.type(';;');
      const search = claude.locator('#resync-quick-picker').getByLabel('Search prompts');
      await search.fill('debug');
      await search.press('Enter');
      const field = claude.locator('#resync-quick-picker').getByLabel('error');
      await field.fill('TypeError: x is undefined');
      await field.press('Enter');
      await expect(claude.locator('.ProseMirror')).toContainText('TypeError: x is undefined');
      await expect(claude.locator('.ProseMirror')).not.toContainText(';;');
      await claude.evaluate(() => (document.querySelector('.ProseMirror').innerHTML = ''));
    });

    await test.step('keys lock and unlock', async () => {
      await tab('Settings');
      await panel.getByLabel('New passphrase').fill('correct horse battery');
      await panel.getByRole('button', { name: 'Create' }).click();
      await expect(panel.getByText('Unlocked for this browser session.')).toBeVisible();
      await panel.getByRole('button', { name: 'Lock' }).click();
      await panel.getByLabel('Passphrase', { exact: true }).fill('wrong one');
      await panel.getByRole('button', { name: 'Unlock' }).click();
      await expect(panel.getByText('Wrong passphrase.')).toBeVisible();
      await panel.getByLabel('Passphrase', { exact: true }).fill('correct horse battery');
      await panel.getByRole('button', { name: 'Unlock' }).click();
      await expect(panel.getByText('Unlocked for this browser session.')).toBeVisible();
    });

    await test.step('a 3-step chain with a timer runs end to end and can be paused', async () => {
      await tab('Prompts');
      await panel.getByLabel('Search prompts').fill('launch plan');
      await panel.getByRole('button', { name: /Run chain/ }).click();
      await panel.getByLabel('product').fill('ReSync, a prompt toolkit');
      await panel.getByRole('button', { name: 'Start chain' }).click();
      // Step 2 is a timer step: pause during its countdown.
      await expect(panel.getByText('Waiting before the next step')).toBeVisible({ timeout: 20_000 });
      await panel.getByRole('button', { name: 'Pause' }).click();
      await expect(panel.getByText('Paused', { exact: true })).toBeVisible({ timeout: 10_000 });
      const sentWhilePaused = await claude.evaluate(() => window.sentMessages.length);
      await claude.waitForTimeout(3000);
      expect(await claude.evaluate(() => window.sentMessages.length)).toBe(sentWhilePaused);
      await panel.getByRole('button', { name: 'Resume' }).click();
      // exact: the tab's description also contains the word "finished"
      await expect(panel.getByText('Finished', { exact: true })).toBeVisible({ timeout: 120_000 });
      const sent = await claude.evaluate(() => window.sentMessages);
      expect(sent.filter((m) => /positioning|launch channels|launch calendar/i.test(m))).toHaveLength(3);
    });

    await test.step('passport and tree in-chat mode', async () => {
      await tab('Passport & more');
      await panel.locator('section.card', { hasText: 'Context Passport' }).getByRole('button', { name: 'Run' }).click();
      await expect(panel.getByRole('button', { name: 'New chat with passport' })).toBeVisible({ timeout: 30_000 });
      await expect(panel.locator('pre').first()).toContainText('## Next 3 steps');
      await expect(panel.locator('pre').first()).toContainText('Next 3 steps for the pricing page.');
      await panel.locator('section.card', { hasText: 'Topic tree' }).getByRole('button', { name: 'Run' }).click();
      await expect(panel.getByRole('heading', { name: 'Topic tree: Pricing chat' })).toBeVisible({ timeout: 30_000 });
      await expect(panel.getByText('Discounts')).toBeVisible();
      await panel.getByRole('button', { name: 'Mermaid' }).click();
      await expect(panel.locator('pre')).toContainText('mindmap');
    });

    await test.step('passport and tree in API mode (mock OpenAI-compatible provider)', async () => {
      await tab('Settings');
      await panel.getByText('Add a provider').click();
      await panel.getByLabel('Type').selectOption('openai-compatible');
      await panel.getByLabel('Name').fill('mock');
      await panel.getByLabel(/^Base URL/).fill(`http://127.0.0.1:${provider.port}/v1`);
      await panel.getByLabel('Default model').fill('mock-model');
      await panel.getByRole('button', { name: 'Add provider' }).click();
      await expect(panel.getByText('Added "mock".')).toBeVisible();
      await panel.locator('.card', { hasText: 'mock' }).getByRole('button', { name: 'Test' }).click();
      await expect(panel.getByText('OK: 1 model(s) available')).toBeVisible();
      await panel.getByLabel('passport mode').selectOption('api');
      await panel.getByLabel('tree mode').selectOption('api');

      await tab('Passport & more');
      await panel.locator('section.card', { hasText: 'Context Passport' }).getByRole('button', { name: 'Run' }).click();
      await expect(panel.locator('pre').first()).toContainText('Goal (from the API).', { timeout: 30_000 });
      await panel.locator('section.card', { hasText: 'Topic tree' }).getByRole('button', { name: 'Run' }).click();
      await expect(panel.getByRole('heading', { name: 'Topic tree: API tree' })).toBeVisible({ timeout: 30_000 });
      // The conversation text went to the provider (after the confirmation), not to any other server.
      expect(provider.requests.some((r) => /<transcript>[\s\S]*(Pricing|launch)/i.test(r.messages.at(-1).content))).toBe(true);
    });

    await test.step('a summary plays aloud', async () => {
      await panel.locator('section.card', { hasText: 'Summary' }).getByRole('button', { name: 'Run' }).click();
      await expect(panel.locator('li', { hasText: 'We priced three plans.' })).toBeVisible({ timeout: 30_000 });
      await panel.evaluate(() => {
        window.__spoken = [];
        const speak = speechSynthesis.speak.bind(speechSynthesis);
        speechSynthesis.speak = (u) => {
          window.__spoken.push(u.text);
          speak(u);
        };
      });
      await panel.getByRole('button', { name: 'Play aloud' }).click();
      expect(await panel.evaluate(() => window.__spoken[0])).toContain('We priced three plans.');
    });

    await test.step('the usage chart shows', async () => {
      await tab('Usage');
      await expect(panel.getByRole('img', { name: /Estimated tokens per day/ })).toBeVisible();
      await expect(panel.getByText('Last 7 days')).toBeVisible();
      await expect(panel.locator('.estimate').first()).toHaveText('estimate');
      await expect(panel.getByText('Launch site')).toBeVisible(); // per-project row from the header project link
    });

    // README screenshot (only with RESYNC_SCREENSHOTS=1): the side panel at a panel-like width.
    if (process.env.RESYNC_SCREENSHOTS === '1') {
      await panel.setViewportSize({ width: 400, height: 760 });
      await tab('Prompts');
      await panel.getByLabel('Search prompts').fill('');
      await panel.screenshot({ path: path.resolve(here, '../../../docs/screenshots/extension-panel.png') });
    }
  } finally {
    await context.close();
    provider.server.close();
  }
});
