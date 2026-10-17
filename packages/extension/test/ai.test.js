import { describe, it, expect } from 'vitest';
import { createAiService } from '../src/background/ai.js';
import { createSettingsStore } from '../src/lib/settings.js';
import { createVault } from '../src/lib/vault.js';
import { memoryArea } from './fakeChrome.js';

const MSGS = [{ role: 'user', content: 'Turn 1: hello' }];

/** OpenAI-style streaming server that records requests. */
function fakeFetch(text = 'Hello there') {
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) });
    const chunks = text.split(' ').map((w, i) => `data: ${JSON.stringify({ choices: [{ delta: { content: (i ? ' ' : '') + w } }] })}\n\n`);
    return new Response(chunks.join('') + `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 3, completion_tokens: 2 } })}\n\ndata: [DONE]\n\n`, { status: 200 });
  };
  f.calls = calls;
  return f;
}

async function setup({ provider, ack = true, granted = true, key } = {}) {
  const settings = createSettingsStore(memoryArea());
  const vault = createVault({ local: memoryArea(), session: memoryArea(), iterations: 1000 });
  await vault.create('passphrase!');
  if (provider) {
    await settings.update((s) => {
      s.ai.providers.p = provider;
      s.ai.features.summary = { mode: 'api', provider: 'p' };
      s.ai.features.tts = { mode: 'api', provider: 'p', model: 'gpt-4o-mini-tts' };
      if (ack) s.privacy.apiModeAcknowledged = { summary: true, tts: true };
    });
  }
  if (key) await vault.setKey('p', key);
  const asked = [];
  const permissions = { contains: async (p) => (asked.push(p.origins), granted) };
  const fetch = fakeFetch();
  return { service: createAiService({ settings, vault, permissions, fetch }), vault, settings, fetch, asked };
}

describe('background API mode', () => {
  it('is off by default with a clear message (no keys needed for in-chat)', async () => {
    const { service } = await setup();
    const r = await service.run({ feature: 'summary', messages: MSGS });
    expect(r).toMatchObject({ ok: false, error: { kind: 'api_off' } });
  });

  it('asks the user to acknowledge that conversation text goes to the provider, per feature', async () => {
    const { service } = await setup({ provider: { type: 'openai-compatible', baseUrl: 'http://localhost:11434/v1', defaultModel: 'qwen' }, ack: false });
    const r = await service.run({ feature: 'summary', messages: MSGS });
    expect(r.ok).toBe(false);
    expect(r.error.kind).toBe('needs_ack');
    expect(r.error.message).toMatch(/sends this conversation's text to p \(http:\/\/localhost:11434\/v1\)/);
  });

  it('requires an unlocked vault and a saved key for keyed providers', async () => {
    const ctx = await setup({ provider: { type: 'openai', defaultModel: 'gpt-6-luna' } });
    expect((await ctx.service.run({ feature: 'summary', messages: MSGS })).error.kind).toBe('auth');
    await ctx.vault.setKey('p', 'sk-test-key');
    await ctx.vault.lock();
    expect((await ctx.service.run({ feature: 'summary', messages: MSGS })).error.kind).toBe('locked');
  });

  it('asks for the provider host permission when it is not granted yet', async () => {
    const { service } = await setup({ provider: { type: 'openai', defaultModel: 'm' }, key: 'sk-test-key', granted: false });
    const r = await service.run({ feature: 'summary', messages: MSGS });
    expect(r.error).toMatchObject({ kind: 'needs_permission', origins: ['https://api.openai.com/*'] });
  });

  it('streams deltas from the provider with the key from the vault', async () => {
    const ctx = await setup({ provider: { type: 'openai', defaultModel: 'gpt-6-luna' }, key: 'sk-test-key' });
    const deltas = [];
    const r = await ctx.service.run({ feature: 'summary', system: 'S', messages: MSGS, maxTokens: 50 }, (d) => deltas.push(d));
    expect(r).toEqual({ ok: true, text: 'Hello there', usage: { inputTokens: 3, outputTokens: 2 }, providerId: 'p', model: 'gpt-6-luna' });
    expect(deltas).toEqual(['Hello', ' there']);
    expect(ctx.fetch.calls[0].headers.authorization).toBe('Bearer sk-test-key');
    expect(ctx.asked[0]).toEqual(['https://api.openai.com/*']);
  });

  it('works with a keyless local model and sends the Anthropic browser header when needed', async () => {
    const local = await setup({ provider: { type: 'openai-compatible', baseUrl: 'http://localhost:11434/v1', defaultModel: 'qwen' } });
    expect((await local.service.run({ feature: 'summary', messages: MSGS })).ok).toBe(true);
    expect(local.fetch.calls[0].headers.authorization).toBeUndefined();

    const ant = await setup({ provider: { type: 'anthropic', defaultModel: 'claude-haiku-5-5' }, key: 'sk-ant-test' });
    await ant.service.run({ feature: 'summary', messages: MSGS }); // response shape is OpenAI-style here, so it fails to parse: we only check the request
    expect(ant.fetch.calls[0].headers['anthropic-dangerous-direct-browser-access']).toBe('true');
  });

  it('returns provider errors in the normalised shape', async () => {
    const settings = createSettingsStore(memoryArea());
    await settings.update((s) => {
      s.ai.providers.p = { type: 'openai', defaultModel: 'm' };
      s.ai.features.summary = { mode: 'api', provider: 'p' };
      s.privacy.apiModeAcknowledged = { summary: true };
    });
    const vault = { getKey: async () => 'sk-test-key' };
    const fetch = async () => new Response(JSON.stringify({ error: { message: 'quota', code: 'insufficient_quota' } }), { status: 429 });
    const r = await createAiService({ settings, vault, permissions: { contains: async () => true }, fetch }).run({ feature: 'summary', messages: MSGS });
    expect(r.error).toMatchObject({ kind: 'quota', provider: 'openai' });
  });

  it('tests a provider connection with the vault key, without needing an acknowledgement', async () => {
    const settings = createSettingsStore(memoryArea());
    await settings.update((s) => {
      s.ai.providers.p = { type: 'openai' };
    });
    const fetch = async (url, init) => new Response(JSON.stringify(init.headers.authorization === 'Bearer sk-test-key' ? { data: [{ id: 'gpt-6-luna' }] } : { error: { message: 'bad' } }), { status: init.headers.authorization === 'Bearer sk-test-key' ? 200 : 401 });
    const svc = createAiService({ settings, vault: { getKey: async () => 'sk-test-key' }, permissions: { contains: async () => true }, fetch });
    expect(await svc.test('p')).toMatchObject({ ok: true, detail: '1 model(s) available' });
    expect(await svc.test('missing')).toMatchObject({ ok: false });
  });

  it('speaks through provider TTS and returns base64 audio', async () => {
    const settings = createSettingsStore(memoryArea());
    await settings.update((s) => {
      s.ai.providers.p = { type: 'openai' };
      s.ai.features.tts = { mode: 'api', provider: 'p', model: 'gpt-4o-mini-tts' };
      s.privacy.apiModeAcknowledged = { tts: true };
    });
    const fetch = async () => new Response(new Uint8Array([104, 105]), { status: 200 });
    const r = await createAiService({ settings, vault: { getKey: async () => 'sk-test-key' }, permissions: { contains: async () => true }, fetch }).speak({ text: 'hi' });
    expect(r).toEqual({ ok: true, audioBase64: 'aGk=', mimeType: 'audio/mpeg' });
  });
});
