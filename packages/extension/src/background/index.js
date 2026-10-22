// Background service worker (MV3). All provider calls in API mode happen here, never in the page.
// Keep no state in globals: the worker can stop after 30 s idle (verified); persist in chrome.storage.
import { createAiService } from './ai.js';
import { createSettingsStore } from '../lib/settings.js';
import { createVault } from '../lib/vault.js';
import { createExtensionSync } from '../lib/syncEngine.js';
import { createLibrary } from '../lib/library.js';
import { createUsageStore } from '../lib/usageEstimates.js';
import { createLedger, checkMessage } from '../lib/ledger.js';
import { ledgerAlertKey } from '../lib/ledgerAlerts.js';
import { migrateRenamedKeys } from '../lib/migrate.js';

const settings = createSettingsStore();
const ai = createAiService({ settings, vault: createVault() });
const ledger = createLedger();
const sync = createExtensionSync({ area: chrome.storage.local, settings, library: createLibrary(), usage: createUsageStore(), ledger });

/**
 * Decision Ledger check for a new message on a claude.ai tab. The result (if any) goes to session storage for the
 * side panel's banner; nothing is ever written into the chat.
 * @param {{ text: string, role: 'user' | 'assistant', chat: string, project?: string }} msg
 * @param {number} tabId
 */
async function ledgerCheck(msg, tabId) {
  if (!msg.text?.trim()) return;
  const r = await checkMessage(msg, {
    ledger,
    // A model is used only when the ledger feature is routed to a provider (Settings > Feature to model).
    modelEnabled: async () => (await settings.get()).ai.features.ledger?.mode === 'api',
    run: (req) => ai.run(req),
  });
  if (!r.alerts.length) return;
  await chrome.storage.session.set({ [ledgerAlertKey(tabId)]: { ...r, chat: msg.chat, role: msg.role, excerpt: msg.text.slice(0, 200), at: Date.now() } });
}

// Clicking the toolbar icon opens the side panel (chrome.sidePanel, Chrome 114+, verified).
chrome.runtime.onInstalled.addListener(() => {
  // Data saved before the rename to ReSync moves to the new keys (a no-op on fresh installs).
  migrateRenamedKeys().catch(() => {});
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  // Background sync every 30 minutes (a no-op when local-only or signed out).
  chrome.alarms.create('resync-sync', { periodInMinutes: 30 });
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'resync-sync') sync.syncNow().catch(() => {});
});

// API mode streams over a port; messages flowing on it keep the worker alive (Chrome 114+, verified).
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'resync:ai') return;
  const ac = new AbortController();
  port.onDisconnect.addListener(() => ac.abort());
  port.onMessage.addListener(async (req) => {
    const result = await ai.run(req, (text) => port.postMessage({ type: 'delta', text }), ac.signal);
    try {
      port.postMessage({ type: 'done', result });
    } catch {
      /* side panel closed */
    }
  });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'resync:syncNow') {
    sync.syncNow().then(sendResponse);
    return true;
  }
  if (msg?.type === 'resync:test') {
    ai.test(msg.providerId).then(sendResponse);
    return true;
  }
  if (msg?.type === 'resync:speak') {
    ai.speak(msg).then(sendResponse);
    return true; // async response
  }
  if (msg?.type === 'resync:ledgerCheck' && sender.tab?.id != null) {
    ledgerCheck(msg, sender.tab.id).catch(() => {});
    return false;
  }
  if (msg?.type === 'resync:openPanel' && sender.tab?.id != null) {
    // From the page's health badge (a click, so a user gesture).
    chrome.sidePanel.open({ tabId: sender.tab.id }).catch(() => {});
    return false;
  }
  if (msg?.type === 'resync:handoffDelivered' && sender.tab?.id != null) {
    chrome.storage.session.set({ [`resync.handoffDelivered.${sender.tab.id}`]: { ...msg, at: Date.now() } }).catch(() => {});
    return false;
  }
  if (msg?.type === 'resync:health' && sender.tab?.id != null) {
    // Latest selector health per tab, for the side panel banner.
    chrome.storage.session.set({ [`resync.health.${sender.tab.id}`]: { ...msg.result, url: msg.url, at: Date.now() } }).catch(() => {});
  }
  return false;
});
