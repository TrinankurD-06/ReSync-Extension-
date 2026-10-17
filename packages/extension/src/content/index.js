// Content script for claude.ai. Bundled as one IIFE file (see vite.content.config.js).
// It only touches the page: no provider calls happen here (API mode lives in the background worker).
import { SETTINGS_KEY, normaliseSettings } from '../lib/settings.js';
import { applyColours, listSidebarItems } from '../lib/colours.js';
import { runHealthCheck } from './health.js';
import { createPicker } from './picker.js';
import { createLibrary } from '../lib/library.js';
import { query } from '../lib/selectors.js';
import { insertText } from '../lib/composer.js';
import { createChainController, realPage, mutationWait } from './chain.js';
import { readConversation, runInChat, takePendingInsert } from './conversation.js';
import { createUsageTracker } from './usageTracker.js';
import { createUsageStore } from '../lib/usageEstimates.js';

const composer = () => query('composer', { overrides: settings.selectorOverrides });
const chains = createChainController({ getOverrides: () => settings.selectorOverrides });

/** @type {import('../lib/settings.js').Settings} */
let settings = normaliseSettings(null);

/** Message handlers from the side panel, by type. Other features register here. */
export const handlers = {
  'resync:ping': () => ({ ok: true }),
  'resync:listItems': () => ({ ok: true, items: listSidebarItems({ overrides: settings.selectorOverrides }) }),
  'resync:health': () => ({ ok: true, result: runHealthCheck({ overrides: settings.selectorOverrides }) }),
  // Insert text (a prompt with its variables already filled) into the message box; the user presses send.
  'resync:insert': (msg) => {
    const c = composer();
    if (!c) return { ok: false, error: "ReSync can't find the message box on this page." };
    return { ok: true, method: insertText(c, String(msg.text ?? ''), { replace: Boolean(msg.replace) }) };
  },
  'resync:chainStart': (msg) => chains.start(msg),
  'resync:chainControl': (msg) => chains.control(msg),
  'resync:chainState': () => chains.state(),
  // API mode: the side panel needs the conversation text (sent to the provider only after the user agreed).
  'resync:readConversation': () => ({ ok: true, messages: readConversation({ overrides: settings.selectorOverrides }) }),
  // In-chat mode: send the instructions in this chat and return Claude's reply.
  'resync:inChat': async (msg) => {
    const mw = mutationWait();
    try {
      return await runInChat(msg.feature, { page: realPage(() => settings.selectorOverrides), wait: mw.wait, overrides: settings.selectorOverrides });
    } finally {
      mw.disconnect();
    }
  },
};

/** After "New chat with passport": put the saved text into the new chat's message box (the user sends it). */
async function deliverPendingInsert() {
  const text = await takePendingInsert();
  if (!text) return;
  for (let i = 0; i < 30; i++) {
    const c = composer();
    if (c) {
      insertText(c, text, { replace: true });
      return;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

function repaint() {
  applyColours(settings.colours.assignments, { overrides: settings.selectorOverrides });
}

/** Run fn at most once per `ms` (trailing), for MutationObserver bursts. */
function debounce(fn, ms) {
  let t;
  return () => {
    clearTimeout(t);
    t = setTimeout(fn, ms);
  };
}

async function start() {
  try {
    settings = normaliseSettings((await chrome.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY]);
  } catch {
    /* extension context invalidated */
  }
  repaint();
  runHealthCheck({ overrides: settings.selectorOverrides });
  const library = createLibrary(chrome.storage.local);
  createPicker({ getPrompts: () => library.list(), getComposer: composer }).attach();
  deliverPendingInsert();

  const usage = createUsageStore(chrome.storage.local);
  const tracker = createUsageTracker({ add: (e) => usage.add(e), getOverrides: () => settings.selectorOverrides });
  tracker.baseline();

  // claude.ai is a single-page app: watch for re-renders and URL changes.
  let lastPath = location.pathname;
  const onMutate = debounce(() => {
    repaint();
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;
      runHealthCheck({ overrides: settings.selectorOverrides });
      tracker.baseline(); // a different chat's history is not new usage
    }
    tracker.scan().catch(() => {});
  }, 300);
  new MutationObserver(onMutate).observe(document.body, { childList: true, subtree: true });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[SETTINGS_KEY]) {
      settings = normaliseSettings(changes[SETTINGS_KEY].newValue);
      repaint();
    }
  });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    const h = handlers[msg?.type];
    if (!h) return false;
    Promise.resolve()
      .then(() => h(msg))
      .then(sendResponse, (e) => sendResponse({ ok: false, error: String(e?.message ?? e) }));
    return true; // async response
  });
}

if (typeof chrome !== 'undefined' && chrome.runtime?.id) start();
