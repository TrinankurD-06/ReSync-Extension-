import { describe, it, expect } from 'vitest';
import { resolveFeature, defaultAiSettings, parseAiSettings, ApiModeOffError, FEATURES } from '../src/featureModels.js';

describe('feature -> model map', () => {
  it('defaults every feature to in-chat with no providers (works with no keys)', () => {
    const s = defaultAiSettings();
    expect(s.providers).toEqual({});
    for (const f of FEATURES) expect(resolveFeature(s, f)).toEqual({ mode: 'in-chat' });
    expect(resolveFeature(undefined, 'passport')).toEqual({ mode: 'in-chat' });
  });

  it('explains how to add a provider when API mode is forced without one', () => {
    expect(() => resolveFeature(defaultAiSettings(), 'passport', { forceApi: true })).toThrow(ApiModeOffError);
    expect(() => resolveFeature(defaultAiSettings(), 'passport', { forceApi: true })).toThrow(/resync keys set/);
  });

  it('routes features to different models', () => {
    const s = parseAiSettings({
      providers: {
        local: { type: 'openai-compatible', baseUrl: 'http://localhost:11434/v1', defaultModel: 'qwen2.5-coder:7b' },
        claude: { type: 'anthropic' },
      },
      features: {
        summary: { mode: 'api', provider: 'local' },
        passport: { mode: 'api', provider: 'claude', model: 'strong-model' },
      },
    });
    expect(resolveFeature(s, 'summary')).toMatchObject({ mode: 'api', providerId: 'local', model: 'qwen2.5-coder:7b' });
    expect(resolveFeature(s, 'passport')).toMatchObject({ mode: 'api', providerId: 'claude', model: 'strong-model' });
    expect(resolveFeature(s, 'tree')).toEqual({ mode: 'in-chat' });
  });

  it('uses the only provider when none is named, and errors clearly otherwise', () => {
    const one = parseAiSettings({ providers: { local: { type: 'openai-compatible', defaultModel: 'm' } } });
    expect(resolveFeature(one, 'tree', { forceApi: true })).toMatchObject({ providerId: 'local', model: 'm' });
    const two = parseAiSettings({ providers: { a: { type: 'openai' }, b: { type: 'gemini' } } });
    expect(() => resolveFeature(two, 'tree', { forceApi: true })).toThrow(/Choose a provider/);
    expect(() => resolveFeature(two, 'tree', { forceApi: true, provider: 'a' })).toThrow(/No model chosen/);
    expect(() => resolveFeature(two, 'tree', { forceApi: true, provider: 'zzz' })).toThrow(/not set up/);
  });

  it('rejects unknown provider types', () => {
    expect(() => parseAiSettings({ providers: { x: { type: 'mystery' } } })).toThrow();
  });
});
