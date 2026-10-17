// API mode, in the background service worker only (spec section 5: never from the page).
// Each request is checked, in order: API mode set up? user acknowledged that this feature sends the
// conversation to the provider? vault unlocked? host permission granted? Only then is the provider called.
import { resolveFeature, ApiModeOffError } from '@resync/shared/models';
import { complete as providerComplete, hostPermissionsFor, speak as providerSpeak, getAdapter, ProviderError, testConnection } from '@resync/shared/providers';
import { VaultLockedError } from '../lib/vault.js';

/**
 * @typedef {{ ok: true, text: string, usage?: { inputTokens: number, outputTokens: number }, providerId: string, model: string }
 *   | { ok: false, error: { kind: string, message: string, hint?: string, origins?: string[], providerId?: string, feature?: string } }} AiResult
 */

/**
 * @param {{
 *   settings: { get(): Promise<import('../lib/settings.js').Settings> },
 *   vault: { getKey(provider: string): Promise<string | null> },
 *   permissions?: { contains(p: { origins: string[] }): Promise<boolean> },
 *   complete?: typeof providerComplete,
 *   speak?: typeof providerSpeak,
 *   fetch?: typeof fetch,
 * }} deps
 */
export function createAiService(deps) {
  const complete = deps.complete ?? providerComplete;
  const speak = deps.speak ?? providerSpeak;
  const permissions = deps.permissions ?? chrome.permissions;

  /**
   * Work out the provider to use and run the pre-flight checks.
   * @param {string} feature
   * @param {{ provider?: string, model?: string }} [o]
   */
  async function prepare(feature, o = {}) {
    const s = await deps.settings.get();
    let route;
    try {
      route = resolveFeature(s.ai, /** @type {any} */ (feature), { forceApi: true, provider: o.provider, model: o.model });
    } catch (e) {
      if (e instanceof ApiModeOffError) return { error: { kind: 'api_off', message: e.message, feature } };
      throw e;
    }
    if (route.mode !== 'api') return { error: { kind: 'api_off', message: 'API mode is off for this feature.', feature } };
    const { providerId, provider, model } = route;
    const label = provider.label ?? providerId;
    if (!s.privacy.apiModeAcknowledged[feature]) {
      return {
        error: {
          kind: 'needs_ack', feature, providerId,
          message: `API mode sends this conversation's text to ${label} (${provider.baseUrl ?? getAdapter(provider.type).defaultBaseUrl}). It does not add messages to your chat. Continue?`,
        },
      };
    }
    let apiKey;
    if (getAdapter(provider.type).requiresKey || (await vaultHas(providerId))) {
      try {
        apiKey = (await deps.vault.getKey(providerId)) ?? undefined;
      } catch (e) {
        if (e instanceof VaultLockedError) return { error: { kind: 'locked', message: e.message } };
        throw e;
      }
      if (!apiKey && getAdapter(provider.type).requiresKey) {
        return { error: { kind: 'auth', message: `No API key saved for ${label}. Add it in Settings > Providers.`, providerId } };
      }
    }
    const cfg = { ...provider, apiKey, browser: true };
    const origins = hostPermissionsFor(cfg);
    if (!(await permissions.contains({ origins }))) {
      return { error: { kind: 'needs_permission', message: `ReSync needs permission to contact ${label}. Click "Allow" in the side panel.`, origins, providerId } };
    }
    return { cfg, providerId, model };
  }

  /** @param {string} providerId */
  async function vaultHas(providerId) {
    try {
      return Boolean(await deps.vault.getKey(providerId));
    } catch {
      return false;
    }
  }

  return {
    /**
     * Run an AI feature in API mode, streaming text deltas.
     * @param {{ feature: string, system?: string, messages: { role: 'user' | 'assistant', content: string }[], maxTokens?: number, provider?: string, model?: string }} req
     * @param {(delta: string) => void} [onDelta]
     * @param {AbortSignal} [signal]
     * @returns {Promise<AiResult>}
     */
    async run(req, onDelta, signal) {
      try {
        const p = await prepare(req.feature, req);
        if ('error' in p) return { ok: false, error: p.error };
        const stream = await complete({ provider: p.cfg, model: p.model, system: req.system, messages: req.messages, maxTokens: req.maxTokens, stream: true }, { fetch: deps.fetch, signal });
        for await (const d of stream) onDelta?.(d);
        const r = await stream.result;
        return { ok: true, text: r.text, usage: r.usage, providerId: p.providerId, model: p.model };
      } catch (e) {
        if (e instanceof ProviderError) return { ok: false, error: e.toJSON() };
        return { ok: false, error: { kind: 'unknown', message: String(/** @type {any} */ (e)?.message ?? e) } };
      }
    },

    /**
     * Check a configured provider (Settings > Test). Uses the vault key; never throws.
     * @param {string} providerId
     */
    async test(providerId) {
      const s = await deps.settings.get();
      const provider = s.ai.providers[providerId];
      if (!provider) return { ok: false, error: { kind: 'unknown', message: `Provider "${providerId}" is not configured.` } };
      let apiKey;
      try {
        apiKey = (await deps.vault.getKey(providerId)) ?? undefined;
      } catch (e) {
        if (e instanceof VaultLockedError) return { ok: false, error: { kind: 'locked', message: e.message } };
      }
      const cfg = { ...provider, apiKey, browser: true };
      if (!(await permissions.contains({ origins: hostPermissionsFor(cfg) }))) {
        return { ok: false, error: { kind: 'needs_permission', message: 'Permission to contact this provider has not been granted.', origins: hostPermissionsFor(cfg) } };
      }
      return testConnection(cfg, { fetch: deps.fetch, model: provider.defaultModel && !getAdapter(provider.type).listModels ? provider.defaultModel : undefined });
    },

    /**
     * Optional provider text-to-speech. Audio comes back base64-encoded (extension messages are JSON).
     * @param {{ text: string, voice?: string, speed?: number }} req
     */
    async speak(req) {
      try {
        const p = await prepare('tts');
        if ('error' in p) return { ok: false, error: p.error };
        const r = await speak(p.cfg, { text: req.text, voice: req.voice, speed: req.speed, model: p.model }, { fetch: deps.fetch });
        const bytes = new Uint8Array(r.audio);
        let s = '';
        for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        return { ok: true, audioBase64: btoa(s), mimeType: r.mimeType };
      } catch (e) {
        if (e instanceof ProviderError) return { ok: false, error: e.toJSON() };
        return { ok: false, error: { kind: 'unknown', message: String(/** @type {any} */ (e)?.message ?? e) } };
      }
    },
  };
}
