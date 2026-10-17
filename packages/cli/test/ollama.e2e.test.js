// REAL end-to-end test with a local model through the OpenAI-compatible adapter (Ollama).
// Opt-in (it loads a multi-GB model): run with RESYNC_E2E_OLLAMA=1, e.g. `npm run test:ollama`.
// Skipped (not failed) when not opted in or when Ollama isn't reachable. Override RESYNC_OLLAMA_URL / RESYNC_OLLAMA_MODEL.
import { describe, it, expect, beforeAll } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { complete, testConnection, listModels } from '@resync/shared/providers';
import { isolateHome, tempDir } from './helpers.js';
import { loadConfig, saveConfig } from '../src/config.js';
import { runApiFeature } from '../src/aiFeatures.js';

const BASE = process.env.RESYNC_OLLAMA_URL ?? 'http://localhost:11434/v1';

async function detect() {
  try {
    const res = await fetch(`${BASE}/models`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return null;
    const ids = (await res.json()).data.map((m) => m.id);
    const preferred = process.env.RESYNC_OLLAMA_MODEL ?? 'qwen2.5-coder:7b';
    return ids.includes(preferred) ? preferred : ids[0] ?? null;
  } catch {
    return null;
  }
}

const OPTED_IN = process.env.RESYNC_E2E_OLLAMA === '1';
const MODEL = OPTED_IN ? await detect() : null;
if (!OPTED_IN) console.info('[resync] local-model end-to-end tests skipped (opt in with RESYNC_E2E_OLLAMA=1 / npm run test:ollama).');
else if (!MODEL) console.warn(`[resync] Ollama not reachable at ${BASE} (or no models pulled): skipping the local-model end-to-end tests ("needs Ollama").`);

const provider = { type: 'openai-compatible', baseUrl: BASE };

describe.skipIf(!MODEL)(`local model end to end via Ollama (${MODEL})`, () => {
  beforeAll(async () => {
    await isolateHome();
  });

  it('testConnection and listModels work with no API key', async () => {
    const r = await testConnection(provider);
    expect(r.ok).toBe(true);
    expect((await listModels(provider)).map((m) => m.id)).toContain(MODEL);
  });

  it('completes a prompt (non-streaming)', async () => {
    const r = await complete({ provider, model: MODEL, system: 'Answer with one word.', messages: [{ role: 'user', content: 'Reply with exactly the word PONG.' }], maxTokens: 20 });
    expect(r.text.toUpperCase()).toContain('PONG');
    expect(r.usage?.inputTokens).toBeGreaterThan(0);
  }, 180_000);

  it('streams a reply', async () => {
    const s = await complete({ provider, model: MODEL, messages: [{ role: 'user', content: 'Count from 1 to 5, separated by spaces.' }], maxTokens: 40, stream: true });
    const deltas = [];
    for await (const d of s) deltas.push(d);
    const r = await s.result;
    expect(deltas.length).toBeGreaterThan(1);
    expect(r.text).toBe(deltas.join(''));
    expect(r.text).toMatch(/1.*2.*3.*4.*5/s);
  }, 180_000);

  it('`resync passport --api` produces a passport from a transcript', async () => {
    const cwd = await tempDir('ollama-proj-');
    const transcript = path.join(cwd, 'session.jsonl');
    const turns = [
      ['user', 'We are building a todo app in React. Please add a dark mode toggle.'],
      ['assistant', 'I added a ThemeContext in src/theme.js and a toggle button in src/Header.jsx. I chose CSS variables over styled-components because the app already uses plain CSS.'],
      ['user', 'The toggle forgets the choice on reload.'],
      ['assistant', 'I tried sessionStorage first but it clears when the tab closes, so I switched to localStorage in src/theme.js. Still open: should we follow the OS preference by default?'],
    ];
    await fs.writeFile(transcript, turns.map(([role, text]) => JSON.stringify({ type: role, message: { role, content: [{ type: 'text', text }] } })).join('\n'));
    const cfg = await loadConfig();
    cfg.ai.providers.local = { type: 'openai-compatible', baseUrl: BASE, defaultModel: MODEL };
    await saveConfig(cfg);

    const r = await runApiFeature('passport', { config: await loadConfig(), cwd, transcript, out: () => {}, err: () => {}, write: () => {} });
    const md = await fs.readFile(r.file, 'utf8');
    expect(md).toMatch(/^# Context Passport/);
    expect(md).toContain('## Next 3 steps');
    expect(r.ok, `missing ${r.missing?.join(', ')} in reply:\n${r.text}`).toBe(true);
    expect(md.toLowerCase()).toMatch(/localstorage|theme/);
  }, 300_000);
});
