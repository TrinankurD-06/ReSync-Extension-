// End-to-end re-test for the composer fix, the Team Decision Ledger and the Chat Health Meter + handoff: the built
// extension in Chromium against a single-page mock of claude.ai (e2e/mock-claude-app.html) and a mock
// OpenAI-compatible provider for the ledger's BYOK conflict check.
// Run: npm run test:e2e -w @resync/extension
import { test, expect, chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { readFileSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(here, '../dist-e2e');
const MOCK_APP = readFileSync(path.join(here, 'mock-claude-app.html'), 'utf8');

/** Mock provider: answers the ledger conflict check (JSON) by marking the PostgreSQL decision as a conflict. */
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
      const prompt = json.messages?.at(-1)?.content ?? '';
      const id = /\[(d\d+)\] Use PostgreSQL/.exec(prompt)?.[1] ?? 'd1';
      const text = prompt.includes('<decisions>') ? JSON.stringify({ results: [{ id, relation: 'conflict', why: 'MongoDB would replace PostgreSQL as the main database.' }] }) : 'ok';
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const chunk of text.match(/[\s\S]{1,30}/g)) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chunk } }] })}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, requests, port: server.address().port })));
}

test('composer on project home pages, decision ledger, chat health and handoff', async () => {
  test.setTimeout(360_000);
  const provider = await startProvider();
  const context = await chromium.launchPersistentContext(mkdtempSync(path.join(os.tmpdir(), 'resync-e2e2-')), {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`],
  });
  try {
    await context.route('https://claude.ai/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: MOCK_APP }));
    let [worker] = context.serviceWorkers();
    worker ??= await context.waitForEvent('serviceworker');
    const extId = new URL(worker.url()).host;

    const claude = await context.newPage();
    await claude.goto('https://claude.ai/project/p1');
    const panel = await context.newPage();
    await panel.goto(`chrome-extension://${extId}/sidepanel.html`);
    const tabId = await panel.evaluate(async () => (await chrome.tabs.query({ url: 'https://claude.ai/*' }))[0].id);
    await panel.goto(`chrome-extension://${extId}/sidepanel.html?tab=${tabId}`);
    panel.on('dialog', (d) => d.accept());
    const tab = (name) => panel.getByRole('tab', { name, exact: true }).click();
    const projectBox = claude.locator('#project-composer .ProseMirror');
    const chatBox = claude.locator('fieldset .ProseMirror');
    /** A Ledger card by its own title (a card's history can mention other decisions). */
    const card = (text) => panel.locator(`[data-testid=decision]:has(> div > strong:text-is("${text}"))`);
    const insertPrompt = async (concept) => {
      await tab('Prompts');
      await panel.getByLabel('Search prompts').fill('explain concept');
      await panel.getByRole('button', { name: 'Insert', exact: true }).first().click();
      await panel.getByLabel('concept').fill(concept);
      await panel.getByRole('button', { name: 'Insert', exact: true }).click();
    };
    const send = async (box, text) => {
      await box.click();
      await claude.keyboard.type(text);
      await claude.keyboard.press('Enter');
      await expect(claude.locator('button[aria-label="Stop response"]')).toHaveCount(0, { timeout: 10_000 });
    };

    await test.step('1. project home page: the composer is found and filled, opened directly and via in-app navigation', async () => {
      // Opened directly: the composer card mounts late, next to the Instructions/Memory editors and a hidden copy.
      await expect(projectBox).toBeVisible();
      await expect(claude.locator('#resync-health-banner')).toHaveCount(0);
      await insertPrompt('caching');
      await expect(projectBox).toContainText('Explain caching three times');
      await expect(claude.locator('#project-composer button[aria-label="Send message"]')).toBeEnabled(); // the editor registered it
      await expect(claude.locator('#instructions')).toHaveText('Write in a friendly tone.');
      await expect(claude.locator('#memory')).toHaveText('Launch is in November.');

      // In-app navigation from a chat: pushState, no reload; the composer appears 600 ms later.
      await claude.goto('https://claude.ai/chat/c1');
      await claude.evaluate(() => (window.__sameDocument = true));
      await claude.locator('nav a[href="/project/p1"]').click();
      await insertPrompt('recursion'); // sent while the card may still be mounting: ReSync waits for it
      await expect(projectBox).toContainText('Explain recursion three times');
      expect(await claude.evaluate(() => [location.pathname, window.__sameDocument])).toEqual(['/project/p1', true]);
      await expect(claude.locator('#instructions')).toHaveText('Write in a friendly tone.');
      await expect(claude.locator('#resync-health-banner')).toHaveCount(0);
    });

    await test.step('2. Context Passport on a sample chat with 3 decisions (one assumed) fills the Ledger', async () => {
      await claude.goto('https://claude.ai/chat/c1');
      await expect(chatBox).toBeVisible();
      await tab('Passport & more');
      await panel.locator('section.card', { hasText: 'Context Passport' }).getByRole('button', { name: 'Run' }).click();
      await expect(panel.getByTestId('ledger-msg')).toContainText('Decision Ledger: 3 added (1 pending', { timeout: 30_000 });
      await tab('Ledger');
      const cards = panel.getByTestId('decision');
      await expect(cards).toHaveCount(3);
      await expect(cards.filter({ hasText: 'Use PostgreSQL for the main database' })).toContainText('Why: the team already knows it');
      await expect(cards.filter({ hasText: 'Use PostgreSQL for the main database' })).toContainText('Launch site');
      const pending = cards.filter({ hasText: 'Offer a free tier' });
      await expect(pending).toHaveAttribute('data-status', 'pending');
      await expect(pending.getByRole('button', { name: 'Confirm' })).toBeVisible();
      await expect(pending.getByRole('button', { name: 'Correct' })).toBeVisible();
      await expect(cards.filter({ hasText: 'Launch on 4 November' })).toHaveAttribute('data-status', 'active');
    });

    await test.step('3. a contradicting message in a new chat shows the banner; Supersede links the history', async () => {
      // A new chat in the project, started from the project home page; no provider yet: "related", never "conflict".
      await claude.goto('https://claude.ai/project/p1');
      await expect(projectBox).toBeVisible();
      await send(projectBox, "Let's move the main database to MongoDB instead.");
      await expect(claude).toHaveURL(/\/chat\/n/);
      const banner = panel.getByTestId('ledger-banner');
      await expect(banner).toContainText('Related team decision', { timeout: 15_000 });
      await expect(banner).toContainText('Use PostgreSQL for the main database');
      await expect(banner).toContainText('Why: the team already knows it');
      await expect(banner).toContainText('Launch site');
      expect(provider.requests).toHaveLength(0);

      // With a BYOK provider for "Decision Ledger checks", the model decides and the banner says conflict.
      await tab('Settings');
      await panel.getByText('Add a provider').click();
      await panel.getByLabel('Type').selectOption('openai-compatible');
      await panel.getByLabel('Name', { exact: true }).fill('mock');
      await panel.getByLabel(/^Base URL/).fill(`http://127.0.0.1:${provider.port}/v1`);
      await panel.getByLabel('Default model').fill('mock-model');
      await panel.getByRole('button', { name: 'Add provider' }).click();
      await expect(panel.getByText('Added "mock".')).toBeVisible();
      await panel.getByLabel('ledger mode').selectOption('api'); // asks once (accepted) what is sent
      await send(chatBox, 'Actually, use MongoDB as the main database from now on.');
      await expect(banner).toContainText('Possible conflict with a team decision', { timeout: 15_000 });
      await expect(banner).toContainText('MongoDB would replace PostgreSQL as the main database.');
      expect(provider.requests.at(-1).messages.at(-1).content).toContain('<decisions>');
      // Nothing was put into the chat input by the banner.
      await expect(chatBox).toHaveText('');

      await banner.getByRole('button', { name: 'Supersede' }).click();
      await panel.getByLabel('New decision').fill('Use MongoDB for the main database');
      await panel.getByLabel('Reason').fill('the data is document-shaped');
      await panel.getByRole('button', { name: 'Save new decision' }).click();
      await expect(panel.getByText('Superseded. The Ledger tab shows the linked history.')).toBeVisible();
      await tab('Ledger');
      await panel.getByLabel('Filter by status').selectOption('all');
      const fresh = card('Use MongoDB for the main database');
      await expect(fresh).toHaveAttribute('data-status', 'active');
      await expect(card('Use PostgreSQL for the main database')).toHaveAttribute('data-status', 'superseded');
      await fresh.getByText('Supersede history (2)').click();
      await expect(fresh.getByTestId('supersede-history').locator('li')).toHaveText([/Use PostgreSQL for the main database \(superseded/, /Use MongoDB for the main database \(active/]);
    });

    await test.step('4. a long chat in a project goes amber then red; the handoff pastes the passport into the project home composer', async () => {
      await tab('Settings');
      await panel.getByLabel('Amber from: Estimated tokens the chat re-reads').fill('1500');
      await panel.getByLabel('Red from: Estimated tokens the chat re-reads').fill('3000');
      const meter = panel.getByTestId('chat-health');
      const badge = claude.locator('#resync-health-badge');
      for (let i = 0; i < 12 && (await meter.getAttribute('data-level').catch(() => null)) !== 'amber'; i++) {
        await send(chatBox, `Tell me more about the launch plan x20 (${i})`);
        await claude.waitForTimeout(500);
      }
      await expect(meter).toHaveAttribute('data-level', 'amber', { timeout: 10_000 });
      await expect(badge).toHaveAttribute('data-level', 'amber');
      await expect(badge).toHaveAttribute('title', /Long chats get slower and more likely to lose earlier details\. Estimate only\./);
      for (let i = 0; i < 12 && (await meter.getAttribute('data-level')) !== 'red'; i++) {
        await send(chatBox, `And the pricing page x20 (${i})`);
        await claude.waitForTimeout(500);
      }
      await expect(meter).toHaveAttribute('data-level', 'red', { timeout: 10_000 });
      await expect(badge).toHaveText('Long chat: hand off?');
      await expect(meter).toContainText('Hand off to a fresh chat?');

      // Snooze: the nudge goes away in this chat (the meter stays).
      await meter.getByRole('button', { name: "Don't remind me in this chat" }).click();
      await expect(badge).toHaveText('Long chat', { timeout: 10_000 });
      await meter.getByRole('button', { name: 'Remind me again' }).click();
      await expect(badge).toHaveText('Long chat: hand off?', { timeout: 10_000 });

      const sourceChat = claude.url();
      await meter.getByRole('button', { name: 'Hand off to a fresh chat' }).click();
      await expect(claude).toHaveURL('https://claude.ai/project/p1', { timeout: 60_000 });
      await expect(projectBox).toContainText('Continue from this handoff brief:', { timeout: 20_000 });
      await expect(projectBox).toContainText('Decisions made (and why)');
      await expect(projectBox).toContainText(`Source: ${sourceChat}`);
      await expect(claude.locator('#project-composer button[aria-label="Send message"]')).toBeEnabled();
      expect(await claude.evaluate(() => window.sentMessages)).toEqual([]); // pasted, not sent (auto-send is off)
      await expect(claude.locator('#instructions')).toHaveText('Write in a friendly tone.');
      await expect(panel.getByTestId('handoff-msg')).toContainText('Check the brief in the new chat, then press Send.');

      // The user sends it: the new chat gets an address and is linked to the source chat (both ways).
      await claude.locator('#project-composer button[aria-label="Send message"]').click();
      await expect(claude).toHaveURL(/\/chat\/n/);
      const newChat = claude.url();
      await expect.poll(async () => (await panel.evaluate(async () => (await chrome.storage.local.get('resync.handoffs'))['resync.handoffs'][0])).newChat, { timeout: 10_000 }).toBe(newChat);
      const h = await panel.evaluate(async () => (await chrome.storage.local.get('resync.handoffs'))['resync.handoffs'][0]);
      expect(h).toMatchObject({ sourceChat, targetUrl: 'https://claude.ai/project/p1', newChat });
      // The saved passport is linked to the source chat and the handoff.
      const art = await panel.evaluate(async () => (await chrome.storage.local.get('resync.artifacts'))['resync.artifacts'][0]);
      expect(art).toMatchObject({ kind: 'passport', data: { sourceChat, handoffId: h.id } });
    });

    if (process.env.RESYNC_SCREENSHOTS === '1') {
      await panel.bringToFront();
      await panel.setViewportSize({ width: 400, height: 760 });
      await tab('Ledger');
      await panel.screenshot({ path: path.resolve(here, '../../../docs/screenshots/extension-ledger.png'), animations: 'disabled' });
    }
  } finally {
    await context.close();
    provider.server.close();
  }
});
