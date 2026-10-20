// Chat Health Meter: how long the current chat has become, as green / amber / red. It reads three things the usage
// tracker already keeps per chat: the estimated tokens the chat re-reads every turn (its cumulative context, the
// high end of the range), the number of turns, and the number of attachments. Thresholds are settings, in those
// units, so they don't assume any one model's context window. An estimate only.

export const HEALTH_TOOLTIP = 'Long chats get slower and more likely to lose earlier details. Estimate only.';
export const SNOOZE_KEY = 'resync.chatHealth.snoozed';
export const LEVELS = /** @type {const} */ (['green', 'amber', 'red']);

/**
 * @typedef {{ tokens: number, turns: number, attachments: number }} Limits
 * @typedef {{ amber: Limits, red: Limits }} HealthThresholds
 * @typedef {{ chat: string, project: string, tokens: number, turns: number, attachments: number }} ChatStats
 * @typedef {{ level: typeof LEVELS[number], reasons: string[], stats: ChatStats }} ChatHealth
 */

/**
 * Defaults: rules of thumb, not a model limit. ~60k / ~120k tokens of chat text is long for any current model's
 * attention even when it fits, and 40 / 80 turns or 8 / 15 attachments make early details easy to lose.
 * @returns {HealthThresholds}
 */
export function defaultThresholds() {
  return { amber: { tokens: 60_000, turns: 40, attachments: 8 }, red: { tokens: 120_000, turns: 80, attachments: 15 } };
}

/** Clean stored thresholds; red is never below amber. @param {any} raw @returns {HealthThresholds} */
export function normaliseThresholds(raw) {
  const d = defaultThresholds();
  const num = (v, fb) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.round(Number(v)) : fb);
  /** @type {any} */
  const out = { amber: {}, red: {} };
  for (const k of /** @type {const} */ (['tokens', 'turns', 'attachments'])) {
    out.amber[k] = num(raw?.amber?.[k], d.amber[k]);
    out.red[k] = Math.max(out.amber[k], num(raw?.red?.[k], d.red[k]));
  }
  return out;
}

const LABEL = { tokens: 'estimated tokens', turns: 'turns', attachments: 'attachments' };

/**
 * The chat's state: the worst of its three measures.
 * @param {ChatStats} stats
 * @param {HealthThresholds} [t]
 * @returns {ChatHealth}
 */
export function chatHealthState(stats, t = defaultThresholds()) {
  const reasons = [];
  let level = 0;
  for (const k of /** @type {const} */ (['tokens', 'turns', 'attachments'])) {
    const v = Number(stats[k]) || 0;
    if (v >= t.red[k]) {
      level = 2;
      reasons.push(`${fmt(v)} ${LABEL[k]} (red from ${fmt(t.red[k])})`);
    } else if (v >= t.amber[k]) {
      level = Math.max(level, 1);
      reasons.push(`${fmt(v)} ${LABEL[k]} (amber from ${fmt(t.amber[k])})`);
    }
  }
  return { level: LEVELS[level], reasons, stats };
}

const fmt = (n) => (n >= 10_000 ? `${Math.round(n / 1000)}k` : String(Math.round(n)));

/** A chat's identity for snoozes and links: its URL without query or hash. @param {string} url */
export const chatKeyOf = (url) => String(url ?? '').split(/[?#]/)[0].replace(/\/+$/, '');

/**
 * "Don't remind me in this chat": snoozed chats keep their meter but never get the hand-off nudge.
 * @param {{ get(k: string): Promise<Record<string, any>>, set(o: Record<string, any>): Promise<void> }} [area]
 */
export function createSnoozes(area) {
  const store = area ?? chrome.storage.local;
  const read = async () => /** @type {Record<string, number>} */ ((await store.get(SNOOZE_KEY))[SNOOZE_KEY] ?? {});
  return {
    /** @param {string} chat */
    async isSnoozed(chat) {
      return Boolean((await read())[chatKeyOf(chat)]);
    },
    /** @param {string} chat */
    async snooze(chat) {
      const all = await read();
      all[chatKeyOf(chat)] = Date.now();
      // Keep the 500 most recent.
      await store.set({ [SNOOZE_KEY]: Object.fromEntries(Object.entries(all).sort((a, b) => b[1] - a[1]).slice(0, 500)) });
    },
    /** @param {string} chat */
    async unsnooze(chat) {
      const all = await read();
      delete all[chatKeyOf(chat)];
      await store.set({ [SNOOZE_KEY]: all });
    },
  };
}

/**
 * Should ReSync offer "Hand off to a fresh chat" on its own? Only in the red state, and never in a snoozed chat.
 * (The button is always available in the panel.)
 * @param {ChatHealth} h
 * @param {boolean} snoozed
 */
export const shouldNudge = (h, snoozed) => h.level === 'red' && !snoozed;
