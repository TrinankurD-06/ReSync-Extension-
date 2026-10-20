// Extension settings (chrome.storage.local). NO secrets here: API keys live only in the vault.
// Defaults follow the spec: local-only (no server), every AI feature in-chat, API mode off until a provider is added.
import { defaultAiSettings, parseAiSettings } from '@resync/shared/models';
import { summaryAudience } from '@resync/shared/templates';
import { mergeChainContext } from '@resync/shared/chains';
import { defaultUsageModel, normaliseUsageModel } from './usageEstimates.js';
import { defaultThresholds, normaliseThresholds } from './chatHealth.js';

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
 *     syncLedger: boolean,                            upload Decision Ledger TEXT (scrubbed); off by default, and the team must allow it too
 *   },
 *   selectorOverrides: Record<string, string[]>,
 *   voice: { voiceURI: string, rate: number, useProviderTts: boolean, ttsProvider: string, ttsVoice: string },
 *   colours: { preset: string, assignments: Record<string, string>, custom: { id: string, label: string, colour: string }[] },
 *   summary: { audience: import('@resync/shared/templates').SummaryAudience },
 *   chains: {
 *     context: import('@resync/shared/chains').ChainContext,   saved facts (team, budget...) reused by every chain; local only
 *     successCriteria: Record<string, boolean>,                per chain slug: success-criteria step on/off
 *   },
 *   usage: import('./usageEstimates.js').UsageModel,
 *   chatHealth: import('./chatHealth.js').HealthThresholds,
 *   handoff: { autoSend: boolean },                     press Send after pasting the handoff brief (off: the user sends)
 *   ledger: { author: string },                         name on decisions you add (the team server name wins when signed in)
 * }} Settings
 */

/** @returns {Settings} */
export function defaultSettings() {
  return {
    serverUrl: '',
    ai: defaultAiSettings(),
    privacy: { apiModeAcknowledged: {}, syncUsage: true, syncColours: true, syncPrompts: true, syncLedger: false },
    selectorOverrides: {},
    voice: { voiceURI: '', rate: 1, useProviderTts: false, ttsProvider: '', ttsVoice: 'marin' },
    colours: { preset: 'startup', assignments: {}, custom: [] },
    summary: { audience: 'recap' },
    chains: { context: mergeChainContext(), successCriteria: {} },
    usage: defaultUsageModel(),
    chatHealth: defaultThresholds(),
    handoff: { autoSend: false },
    ledger: { author: '' },
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
    summary: { audience: summaryAudience(r.summary?.audience) },
    chains: {
      // Only the reusable facts are kept; per-run inputs and assumptions belong to one run.
      context: { ...mergeChainContext(r.chains?.context), inputs: {}, assumptions: [] },
      successCriteria: Object.fromEntries(Object.entries(r.chains?.successCriteria ?? {}).filter(([, v]) => typeof v === 'boolean')),
    },
    usage: normaliseUsageModel(r.usage),
    chatHealth: normaliseThresholds(r.chatHealth),
    handoff: { autoSend: r.handoff?.autoSend === true },
    ledger: { author: typeof r.ledger?.author === 'string' ? r.ledger.author.trim().slice(0, 200) : '' },
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
