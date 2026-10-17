// Extension settings (chrome.storage.local). NO secrets here: API keys live only in the vault.
// Defaults follow the spec: local-only (no server), every AI feature in-chat, API mode off until a provider is added.
import { defaultAiSettings, parseAiSettings } from '@resync/shared/models';

export const SETTINGS_KEY = 'resync.settings';

/**
 * @typedef {{
 *   serverUrl: string,
 *   ai: import('@resync/shared/models').AiSettings,
 *   privacy: {
 *     apiModeAcknowledged: Record<string, boolean>,   per feature: user saw "conversation text is sent to <provider>"
 *     syncUsage: boolean,                             upload usage NUMBERS when signed in
 *     syncColours: boolean,
 *     syncPrompts: boolean,
 *   },
 *   selectorOverrides: Record<string, string[]>,
 *   voice: { voiceURI: string, rate: number, useProviderTts: boolean, ttsProvider: string, ttsVoice: string },
 *   colours: { preset: string, assignments: Record<string, string>, custom: { id: string, label: string, colour: string }[] },
 * }} Settings
 */

/** @returns {Settings} */
export function defaultSettings() {
  return {
    serverUrl: '',
    ai: defaultAiSettings(),
    privacy: { apiModeAcknowledged: {}, syncUsage: true, syncColours: true, syncPrompts: true },
    selectorOverrides: {},
    voice: { voiceURI: '', rate: 1, useProviderTts: false, ttsProvider: '', ttsVoice: 'marin' },
    colours: { preset: 'startup', assignments: {}, custom: [] },
  };
}

/** Merge stored values over defaults (one level deep per section). @param {any} raw @returns {Settings} */
export function normaliseSettings(raw) {
  const d = defaultSettings();
  const r = raw && typeof raw === 'object' ? raw : {};
  let ai;
  try {
    ai = parseAiSettings(r.ai ?? {});
  } catch {
    ai = d.ai; // corrupt AI settings fall back to safe defaults (in-chat, no providers)
  }
  return {
    serverUrl: typeof r.serverUrl === 'string' ? r.serverUrl.trim() : d.serverUrl,
    ai,
    privacy: { ...d.privacy, ...(r.privacy ?? {}), apiModeAcknowledged: { ...(r.privacy?.apiModeAcknowledged ?? {}) } },
    selectorOverrides: { ...(r.selectorOverrides ?? {}) },
    voice: { ...d.voice, ...(r.voice ?? {}) },
    colours: { ...d.colours, ...(r.colours ?? {}), assignments: { ...(r.colours?.assignments ?? {}) }, custom: [...(r.colours?.custom ?? [])] },
  };
}

/**
 * @param {{ get(k: string): Promise<Record<string, any>>, set(o: Record<string, any>): Promise<void> }} [area]
 */
export function createSettingsStore(area) {
  const store = area ?? chrome.storage.local;
  return {
    /** @returns {Promise<Settings>} */
    async get() {
      return normaliseSettings((await store.get(SETTINGS_KEY))[SETTINGS_KEY]);
    },
    /**
     * Apply a change and save. Refuses anything that looks like an API key (keys belong in the vault).
     * @param {(s: Settings) => void | Settings} fn
     */
    async update(fn) {
      const s = await this.get();
      const next = normaliseSettings(fn(s) ?? s);
      if (/\b(sk-[A-Za-z0-9_-]{8,}|AIza[0-9A-Za-z_-]{20,})\b/.test(JSON.stringify(next))) {
        throw new Error('That looks like an API key. Keys go in the encrypted vault, not in settings.');
      }
      await store.set({ [SETTINGS_KEY]: next });
      return next;
    },
  };
}
