// Feature -> model map. ReSync works with no API keys: every feature defaults to in-chat mode,
// and API mode only becomes possible once the user adds a provider.
import { z } from 'zod';

export const FEATURES = /** @type {const} */ (['passport', 'tree', 'summary', 'promptTools', 'tts', 'ledger']);
export const PROVIDER_TYPES = /** @type {const} */ (['anthropic', 'openai', 'gemini', 'openrouter', 'openai-compatible']);

const providerSchema = z.object({
  type: z.enum(PROVIDER_TYPES),
  label: z.string().max(100).optional(),
  baseUrl: z.string().url().optional(),
  defaultModel: z.string().max(200).optional(),
});

const featureSchema = z.object({
  mode: z.enum(['in-chat', 'api']).default('in-chat'),
  provider: z.string().optional(),
  model: z.string().max(200).optional(),
});

export const aiSettingsSchema = z.object({
  providers: z.record(z.string().regex(/^[a-z0-9][a-z0-9-]*$/), providerSchema).default({}),
  // partialRecord: zod 4's z.record with enum keys requires every key.
  features: z.partialRecord(z.enum(FEATURES), featureSchema).default({}),
});

/** @typedef {z.infer<typeof aiSettingsSchema>} AiSettings */

/** Settings for a fresh install: no providers, everything in-chat. */
export function defaultAiSettings() {
  return {
    providers: {},
    features: Object.fromEntries(FEATURES.map((f) => [f, { mode: 'in-chat' }])),
  };
}

export class ApiModeOffError extends Error {
  /** @param {string} message @param {string} feature */
  constructor(message, feature) {
    super(message);
    this.name = 'ApiModeOffError';
    this.feature = feature;
  }
}

/**
 * Decide how a feature runs.
 * @param {Partial<AiSettings> | undefined} settings
 * @param {typeof FEATURES[number]} feature
 * @param {{ forceApi?: boolean, provider?: string, model?: string }} [opts]
 *   forceApi: the user explicitly asked for API mode (e.g. `--api`). provider/model override the map.
 * @returns {{ mode: 'in-chat' } | { mode: 'api', providerId: string, provider: z.infer<typeof providerSchema>, model: string }}
 * @throws {ApiModeOffError} when API mode was requested but no usable provider is configured
 */
export function resolveFeature(settings, feature, opts = {}) {
  const providers = settings?.providers ?? {};
  const fs = settings?.features?.[feature] ?? { mode: 'in-chat' };
  const wantsApi = opts.forceApi || fs.mode === 'api';
  if (!wantsApi) return { mode: 'in-chat' };

  const ids = Object.keys(providers);
  if (ids.length === 0) {
    throw new ApiModeOffError(
      `API mode is off: no AI provider is set up. ReSync works without keys in in-chat mode; to use API mode, add a provider first (CLI: \`resync keys set <provider>\`, extension: Settings > Providers).`,
      feature,
    );
  }
  const providerId = opts.provider ?? fs.provider ?? (ids.length === 1 ? ids[0] : undefined);
  if (!providerId || !providers[providerId]) {
    throw new ApiModeOffError(
      providerId
        ? `Provider "${providerId}" is not set up. Configured: ${ids.join(', ')}.`
        : `Choose a provider for "${feature}" (configured: ${ids.join(', ')}).`,
      feature,
    );
  }
  const provider = providers[providerId];
  const model = opts.model ?? fs.model ?? provider.defaultModel;
  if (!model) {
    throw new ApiModeOffError(`No model chosen for "${feature}" on provider "${providerId}". Set one in the feature to model map.`, feature);
  }
  return { mode: 'api', providerId, provider, model };
}

/**
 * Validate and fill defaults.
 * @param {unknown} raw
 * @returns {AiSettings}
 */
export function parseAiSettings(raw) {
  const parsed = aiSettingsSchema.parse(raw ?? {});
  const base = defaultAiSettings();
  return { providers: parsed.providers, features: { ...base.features, ...parsed.features } };
}
