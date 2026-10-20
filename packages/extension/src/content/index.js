// Content script for claude.ai. Bundled as one IIFE file (see vite.content.config.js).
// It only touches the page: no provider calls happen here (API mode lives in the background worker).
import { SETTINGS_KEY, normaliseSettings } from '../lib/settings.js';
import { applyColours, listSidebarItems } from '../lib/colours.js';
import { runHealthCheck } from './health.js';
import { createPicker } from './picker.js';
import { createLibrary } from '../lib/library.js';
import { findComposer, waitForComposer, watchUrl, isChatPage, pageType, isSendButton } from '../lib/selectors.js';
import { createChainController, realPage, mutationWait } from './chain.js';
import { readConversation, runInChat, takePendingInsertItem, scrollToTurn, pageMeta } from './conversation.js';
import { createUsageTracker } from './usageTracker.js';
import { createUsageStore } from '../lib/usageEstimates.js';
import { deliverText, trackFocus } from './deliver.js';
import { chatHealthState, chatKeyOf, createSnoozes, shouldNudge } from '../lib/chatHealth.js';
import { createHandoffs } from '../lib/handoff.js';
import { renderBadge } from './badge.js';

const composer = () => findComposer({ overrides: settings.selectorOverrides })?.el ?? null;
const chains = createChainController({ getOverrides: () => settings.selectorOverrides });

/** @type {import('../lib/settings.js').Settings} */
let settings = normaliseSettings(null);
/** The latest chat stats from the usage tracker (for the Chat Health Meter). */
let stats = /** @type {{ chatId: string, project: string, tokens: number, turns: number, attachments: number } | null} */ (null);
/** A handoff whose brief was pasted on this page: linked to the new chat once it gets its URL. */
let pendingHandoff = /** @type {string | null} */ (null);

/** Current chat health (null on pages that are not a chat yet). */
async function currentHealth() {
  if (!stats || pageType(location.pathname) !== 'chat') return null;
  const chat = chatKeyOf(location.href);
  const health = chatHealthState({ chat, project: stats.project, tokens: stats.tokens, turns: stats.turns, attachments: stats.attachments }, settings.chatHealth);
  const snoozed = await createSnoozes(chrome.storage.local).isSnoozed(chat).catch(() => false);
  return { ...health, chat, snoozed, nudge: shouldNudge(health, snoozed) };
}

async function paintBadge() {
  const h = await currentHealth();
  renderBadge(h, { nudge: h?.nudge, onClick: () => send({ type: 'resync:openPanel' }) });
}

/** @param {unknown} msg */
function send(msg) {
  try {
    chrome.runtime.sendMessage(msg).catch(() => {});
  } catch {
    /* extension context gone (e.g. after an update) */
  }
}

/** Message handlers from the side panel, by type. Other features register here. */
export const handlers = {
  'resync:ping': () => ({ ok: true }),
  'resync:listItems': () => ({ ok: true, items: listSidebarItems({ overrides: settings.selectorOverrides }) }),
  'resync:health': () => ({ ok: true, result: runHealthCheck({ overrides: settings.selectorOverrides }) }),
  // Insert text (a prompt with its variables filled, or a ledger decision) into the message box; the user presses send.
  // Works on chat, new-chat and project home pages; on failure the page shows Retry and the text is copied.
  'resync:insert': (msg) => deliverText(String(msg.text ?? ''), { replace: Boolean(msg.replace), overrides: settings.selectorOverrides, timeoutMs: 3000 }),
  'resync:chainStart': (msg) => chains.start(msg),
  'resync:chainControl': (msg) => chains.control(msg),
  'resync:chainState': () => chains.state(),
  // API mode: the side panel needs the conversation text (sent to the provider only after the user agreed).
  'resync:readConversation': () => ({ ok: true, messages: readConversation({ overrides: settings.selectorOverrides }), meta: pageMeta({ overrides: settings.selectorOverrides }) }),
  // Topic tree: clicking a topic scrolls the chat to the first turn of its range.
  'resync:scrollToTurn': (msg) => scrollToTurn(msg.turn, { overrides: settings.selectorOverrides }),
  // In-chat mode: send the instructions in this chat and return Claude's reply.
  'resync:inChat': async (msg) => {
    const mw = mutationWait();
    try {
      return await runInChat(msg.feature, { page: realPage(() => settings.selectorOverrides), wait: mw.wait, overrides: settings.selectorOverrides, audience: msg.audience });
    } finally {
      mw.disconnect();
    }
  },
  // Chat Health Meter for the side panel.
  'resync:chatHealth': async () => ({ ok: true, health: await currentHealth(), meta: pageMeta({ overrides: settings.selectorOverrides }), page: pageType(location.pathname) }),
  'resync:repaintBadge': async () => {
    await paintBadge();
    return { ok: true };
  },
};

/** After a handoff or "New chat with passport": put the saved text into this page's message box. */
async function deliverPendingInsert() {
  const item = await takePendingInsertItem();
  if (!item) return;
  const r = await deliverText(item.text, { replace: true, autoSend: item.autoSend, overrides: settings.selectorOverrides, timeoutMs: 15_000 });
  if (item.handoffId) {
    pendingHandoff = item.handoffId;
    send({ type: 'resync:handoffDelivered', handoffId: item.handoffId, ok: r.ok, page: pageType(location.pathname) });
    linkHandoff();
  }
}

/** Once the new chat has an address (after its first message), link it to the chat it was handed off from. */
async function linkHandoff() {
  if (!pendingHandoff || pageType(location.pathname) !== 'chat') return;
  const id = pendingHandoff;
  pendingHandoff = null;
  await createHandoffs(chrome.storage.local).linkNewChat(id, location.href).catch(() => {});
}

/** Selector health, after giving the composer time to mount (it renders late after in-app navigation). */
async function checkHealth() {
  // The URL changes before the app re-renders, so the composer found first can be the previous page's, about to be
  // removed: if it is gone by the time we look again, wait for the new one.
  for (let i = 0; i < 3 && isChatPage(location.pathname); i++) {
    const found = await waitForComposer({ overrides: settings.selectorOverrides, timeoutMs: 8000, pathname: () => location.pathname });
    await new Promise((r) => setTimeout(r, 0));
    if (!found || found.el.isConnected) break;
  }
  runHealthCheck({ overrides: settings.selectorOverrides });
}

function repaint() {
  applyColours(settings.colours.assignments, { overrides: settings.selectorOverrides, custom: settings.colours.custom });
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
  checkHealth();
  trackFocus();
  const library = createLibrary(chrome.storage.local);
  createPicker({ getPrompts: () => library.list(), getComposer: composer }).attach();
  deliverPendingInsert();

  const usage = createUsageStore(chrome.storage.local);
  let lastStats = '';
  const tracker = createUsageTracker({
    add: (e) => usage.add(e),
    getOverrides: () => settings.selectorOverrides,
    getModel: () => settings.usage,
    memory: usage,
    // Decision Ledger: each new message is checked against the team's decisions (in the background worker).
    onMessage: (m) => send({ type: 'resync:ledgerCheck', role: m.role, text: m.text.slice(0, 8000), chat: chatKeyOf(location.href), project: pageMeta({ overrides: settings.selectorOverrides }).project }),
    onStats: (s) => {
      stats = s;
      const key = JSON.stringify(s);
      if (key === lastStats) return;
      lastStats = key;
      paintBadge();
    },
  });
  tracker.baseline();

  // Sending the first message from a new-chat or project home page makes claude.ai move to /chat/<id>. That is the
  // same conversation continuing, not a different chat, so it must not be reset (or its first message would be
  // treated as old history: not counted, not checked against the ledger).
  let lastPage = pageType(location.pathname);
  let sentAt = 0;
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && findComposer({ overrides: settings.selectorOverrides })?.el.contains(/** @type {Node} */ (e.target))) sentAt = Date.now();
  }, true);
  document.addEventListener('click', (e) => {
    if (isSendButton(e.target, { overrides: settings.selectorOverrides })) sentAt = Date.now();
  }, true);

  // claude.ai is a single-page app: URL changes (pushState via the main-world nav hook, back/forward, or seen on
  // re-render) mean a different page; the composer may mount later, so detection waits for it.
  watchUrl(() => {
    const to = pageType(location.pathname);
    const startedChat = (lastPage === 'new-chat' || lastPage === 'project-home') && to === 'chat' && Date.now() - sentAt < 15_000;
    lastPage = to;
    stats = null;
    renderBadge(null);
    checkHealth();
    if (!startedChat) tracker.baseline(); // a different chat's history is not new usage
    linkHandoff();
    deliverPendingInsert();
  });
  const onMutate = debounce(() => {
    repaint();
    tracker.scan().catch(() => {});
  }, 300);
  new MutationObserver(onMutate).observe(document.body, { childList: true, subtree: true });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[SETTINGS_KEY]) {
      settings = normaliseSettings(changes[SETTINGS_KEY].newValue);
      repaint();
      paintBadge();
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
