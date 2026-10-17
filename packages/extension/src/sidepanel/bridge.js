// Side panel <-> background / content script messaging.
import { createExtensionSync } from '../lib/syncEngine.js';
import { createSettingsStore } from '../lib/settings.js';
import { createLibrary } from '../lib/library.js';
import { createUsageStore } from '../lib/usageEstimates.js';

/**
 * Sync engine for the side panel (sign-in polling runs here: the panel stays alive while the user approves,
 * unlike the service worker, which can stop after 30 s idle).
 */
export function panelSync() {
  return createExtensionSync({ area: chrome.storage.local, settings: createSettingsStore(), library: createLibrary(), usage: createUsageStore() });
}

/**
 * Run an AI feature in API mode through the background worker, streaming deltas.
 * @param {{ feature: string, system?: string, messages: { role: string, content: string }[], maxTokens?: number }} req
 * @param {(text: string) => void} [onDelta]
 * @returns {Promise<import('../background/ai.js').AiResult>}
 */
export function aiRun(req, onDelta) {
  return new Promise((resolve) => {
    const port = chrome.runtime.connect({ name: 'resync:ai' });
    let done = false;
    port.onMessage.addListener((msg) => {
      if (msg.type === 'delta') onDelta?.(msg.text);
      if (msg.type === 'done') {
        done = true;
        resolve(msg.result);
        port.disconnect();
      }
    });
    port.onDisconnect.addListener(() => {
      if (!done) resolve({ ok: false, error: { kind: 'network', message: 'The background worker stopped. Try again.' } });
    });
    port.postMessage(req);
  });
}

/** @param {string} providerId */
export const testProvider = (providerId) => chrome.runtime.sendMessage({ type: 'resync:test', providerId });

/** @param {{ text: string, voice?: string, speed?: number }} req */
export const providerSpeak = (req) => chrome.runtime.sendMessage({ type: 'resync:speak', ...req });

/** The active claude.ai tab, if the current tab is one. */
export async function activeClaudeTab() {
  // Test hook: when the panel is opened as a normal page (end-to-end tests), ?tab=<id> names the target tab.
  const forced = Number(new URLSearchParams(location.search).get('tab'));
  if (forced) return chrome.tabs.get(forced).catch(() => null);
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.url?.startsWith('https://claude.ai/') ? tab : null;
}

/**
 * Send a message to the content script in the active claude.ai tab.
 * @param {Record<string, unknown>} msg
 */
export async function toPage(msg) {
  const tab = await activeClaudeTab();
  if (!tab?.id) return { ok: false, error: 'Open a claude.ai tab first.' };
  try {
    return await chrome.tabs.sendMessage(tab.id, msg);
  } catch {
    return { ok: false, error: 'ReSync is not running on this tab yet. Reload the claude.ai page.' };
  }
}
