import { describe, it, expect } from 'vitest';
import { createSettingsStore, defaultSettings, normaliseSettings } from '../src/lib/settings.js';
import { resolveFeature } from '@resync/shared/models';
import { memoryArea } from './fakeChrome.js';

describe('extension settings', () => {
  it('defaults: local-only, no providers, every feature in-chat (works with no keys)', async () => {
    const s = await createSettingsStore(memoryArea()).get();
    expect(s.serverUrl).toBe('');
    expect(s.ai.providers).toEqual({});
    for (const f of ['passport', 'tree', 'summary']) expect(resolveFeature(s.ai, f)).toEqual({ mode: 'in-chat' });
    expect(s.privacy.apiModeAcknowledged).toEqual({});
  });

  it('saves changes and keeps unrelated sections', async () => {
    const store = createSettingsStore(memoryArea());
    await store.update((s) => {
      s.serverUrl = ' https://resync.example.com ';
      s.ai.providers.local = { type: 'openai-compatible', baseUrl: 'http://localhost:11434/v1', defaultModel: 'qwen' };
      s.ai.features.summary = { mode: 'api', provider: 'local' };
    });
    const s = await store.get();
    expect(s.serverUrl).toBe('https://resync.example.com');
    expect(resolveFeature(s.ai, 'summary')).toMatchObject({ mode: 'api', providerId: 'local', model: 'qwen' });
    expect(s.voice.rate).toBe(1);
  });

  it('refuses to store API keys in settings', async () => {
    const store = createSettingsStore(memoryArea());
    await expect(store.update((s) => { s.ai.providers.x = { type: 'openai', label: 'sk-abcdefghijklmnop' }; })).rejects.toThrow(/vault/);
  });

  it('falls back to safe defaults for corrupt data', () => {
    const s = normaliseSettings({ ai: { providers: { bad: { type: 'nope' } } }, voice: { rate: 1.5 } });
    expect(s.ai).toEqual(defaultSettings().ai);
    expect(s.voice.rate).toBe(1.5);
    expect(normaliseSettings(null)).toEqual(defaultSettings());
  });
});
