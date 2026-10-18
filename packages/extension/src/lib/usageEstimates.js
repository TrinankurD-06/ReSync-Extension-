// Usage ESTIMATES from the extension, per day and project. Numbers only: no message text is stored. Synced to the
// team server as usage records (source "extension").
//
// Two figures, both estimates (claude.ai doesn't show real token counts):
//  - typedTokens: tokens in what the user typed.
//  - processed (low to high): what claude.ai actually processed. Every turn re-reads the whole chat so far, plus
//    the project files and hidden instructions, plus attachments; then it writes the reply. Much of that can't be
//    seen from the page, so it is a range.
import { localDate } from '@resync/shared/usage';

export const USAGE_KEY = 'resync.usage';
/** Running context size per chat (numbers only), so a reloaded chat keeps its re-read cost. */
export const CHATS_KEY = 'resync.usage.chats';
/** Project knowledge sizes read from claude.ai project pages, by project name. */
export const PROJECT_FILES_KEY = 'resync.usage.projectFiles';

/**
 * @typedef {{ low: number, high: number }} Range
 * @typedef {{
 *   imageTokens: Range,              per attached image
 *   fileTokens: Range,               per attached file (its size isn't shown on the page)
 *   hiddenTokens: Range,             system prompt, tools, memory: unknown, so a wide allowance
 *   projectDefault: Range,           project files when nothing was detected or entered
 *   projectCapacityTokens: number,   what "100% of project capacity" means, for converting the page's percentage
 *   projectFiles: Record<string, number>,  tokens entered by the user in Settings, by project name
 * }} UsageModel
 */

/** @returns {UsageModel} */
export function defaultUsageModel() {
  return {
    imageTokens: { low: 800, high: 1600 },
    fileTokens: { low: 500, high: 5000 },
    hiddenTokens: { low: 2000, high: 20000 },
    projectDefault: { low: 0, high: 10000 },
    projectCapacityTokens: 200_000,
    projectFiles: {},
  };
}

/** Clean a stored usage model (bad numbers fall back to the defaults). @param {any} raw @returns {UsageModel} */
export function normaliseUsageModel(raw) {
  const d = defaultUsageModel();
  const r = raw && typeof raw === 'object' ? raw : {};
  const num = (v, fb) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.round(Number(v)) : fb);
  const range = (v, fb) => {
    const low = num(v?.low, fb.low);
    const high = num(v?.high, fb.high);
    return { low: Math.min(low, high), high: Math.max(low, high) };
  };
  /** @type {Record<string, number>} */
  const projectFiles = {};
  for (const [k, v] of Object.entries(r.projectFiles ?? {})) if (k.trim() && Number.isFinite(Number(v)) && Number(v) >= 0) projectFiles[k.trim()] = Math.round(Number(v));
  return {
    imageTokens: range(r.imageTokens, d.imageTokens),
    fileTokens: range(r.fileTokens, d.fileTokens),
    hiddenTokens: range(r.hiddenTokens, d.hiddenTokens),
    projectDefault: range(r.projectDefault, d.projectDefault),
    projectCapacityTokens: num(r.projectCapacityTokens, d.projectCapacityTokens) || d.projectCapacityTokens,
    projectFiles,
  };
}

const add = (/** @type {Range} */ a, /** @type {Range} */ b) => ({ low: a.low + b.low, high: a.high + b.high });
const times = (/** @type {Range} */ r, n) => ({ low: r.low * n, high: r.high * n });
const exact = (n) => ({ low: n, high: n });

/**
 * Size of a project's files, in this order: detected from the project page, else entered in Settings, else the
 * configurable default. Chats outside a project have none.
 * @param {string} project
 * @param {{ detected?: Record<string, Range>, model: UsageModel }} o
 * @returns {Range & { source: 'detected' | 'settings' | 'default' | 'none' }}
 */
export function projectFileTokens(project, o) {
  if (!project || project === 'No project') return { low: 0, high: 0, source: 'none' };
  const det = o.detected?.[project];
  if (det && Number.isFinite(det.low) && Number.isFinite(det.high)) return { low: det.low, high: det.high, source: 'detected' };
  const entered = o.model.projectFiles[project];
  if (entered != null) return { low: entered, high: entered, source: 'settings' };
  return { ...o.model.projectDefault, source: 'default' };
}

/**
 * The project page shows "N% of project capacity used". Convert it to a token range (the percentage is rounded,
 * so +-0.5%).
 * @param {number} percent
 * @param {number} capacityTokens
 * @returns {Range}
 */
export function capacityToTokens(percent, capacityTokens) {
  const p = Math.max(0, Number(percent) || 0);
  return { low: Math.round((Math.max(0, p - 0.5) / 100) * capacityTokens), high: Math.round(((p + 0.5) / 100) * capacityTokens) };
}

/** Tokens for a message's attachments. @param {{ images?: number, files?: number }} a @param {UsageModel} model */
export function attachmentTokens(a, model) {
  return add(times(model.imageTokens, a.images ?? 0), times(model.fileTokens, a.files ?? 0));
}

/**
 * Running estimate for one chat. Each user message is processed together with everything before it in the chat
 * (the context is re-read every turn), the project files and the hidden instructions; each reply adds its own
 * tokens and joins the context.
 * @param {{ model: UsageModel, project: Range, context?: Range }} o
 */
export function createChatEstimator(o) {
  let context = o.context ? { ...o.context } : exact(0);
  return {
    /** Context so far (for saving). */
    get context() {
      return { ...context };
    },
    /** History already in the chat: it joins the context but is not new usage. @param {{ tokens: number, images?: number, files?: number }} m */
    seed(m) {
      context = add(context, add(exact(m.tokens), attachmentTokens(m, o.model)));
    },
    /**
     * A message the user sent.
     * @param {{ tokens: number, images?: number, files?: number }} m
     * @returns {{ typed: number, processed: Range, parts: Record<string, Range> }}
     */
    user(m) {
      const parts = {
        earlierTurns: { ...context },
        message: exact(m.tokens),
        attachments: attachmentTokens(m, o.model),
        projectFiles: { low: o.project.low, high: o.project.high },
        hidden: { ...o.model.hiddenTokens },
      };
      const processed = Object.values(parts).reduce(add, exact(0));
      context = add(context, add(parts.message, parts.attachments));
      return { typed: m.tokens, processed, parts };
    },
    /** A finished reply: its tokens are written once, then re-read in later turns. @param {{ tokens: number }} m */
    reply(m) {
      context = add(context, exact(m.tokens));
      return { processed: exact(m.tokens) };
    },
  };
}

/**
 * Whole-chat estimate (all turns counted as new usage), with the arithmetic per turn. Used by tests and docs.
 * @param {{ role: 'user' | 'assistant', tokens: number, images?: number, files?: number }[]} turns
 * @param {{ model: UsageModel, project: Range }} o
 */
export function estimateChat(turns, o) {
  const est = createChatEstimator(o);
  let typed = 0;
  let processed = exact(0);
  const rows = [];
  for (const t of turns) {
    if (t.role === 'user') {
      const r = est.user(t);
      typed += r.typed;
      processed = add(processed, r.processed);
      rows.push({ role: t.role, ...r });
    } else {
      const r = est.reply(t);
      processed = add(processed, r.processed);
      rows.push({ role: t.role, ...r });
    }
  }
  return { typed, processed, rows };
}

/**
 * @typedef {{ date: string, project: string, messages: number, typedTokens: number, processedLow: number, processedHigh: number }} DayProject
 * @param {{ get(k: string): Promise<Record<string, any>>, set(o: Record<string, any>): Promise<void> }} [area]
 */
export function createUsageStore(area) {
  const store = area ?? chrome.storage.local;
  const read = async () => {
    /** @type {Record<string, any>} */
    const all = (await store.get(USAGE_KEY))[USAGE_KEY] ?? {};
    // Rows from before the split kept one "estimatedTokens" figure (typed text plus replies).
    for (const r of Object.values(all)) {
      r.typedTokens ??= r.estimatedTokens ?? 0;
      r.processedLow ??= 0;
      r.processedHigh ??= 0;
      delete r.estimatedTokens;
    }
    return /** @type {Record<string, DayProject>} */ (all);
  };
  return {
    /**
     * Add to today's totals for a project.
     * @param {{ project: string, messages?: number, typedTokens?: number, processed?: Range, date?: Date }} e
     */
    async add(e) {
      const date = localDate(e.date ?? new Date());
      const project = (e.project || 'No project').slice(0, 120);
      const all = await read();
      const key = `${date}|${project}`;
      const cur = all[key] ?? { date, project, messages: 0, typedTokens: 0, processedLow: 0, processedHigh: 0 };
      cur.messages += Math.max(0, e.messages ?? 0);
      cur.typedTokens += Math.max(0, Math.round(e.typedTokens ?? 0));
      cur.processedLow += Math.max(0, Math.round(e.processed?.low ?? 0));
      cur.processedHigh += Math.max(0, Math.round(e.processed?.high ?? 0));
      all[key] = cur;
      // Keep 90 days.
      const cutoff = localDate(new Date(Date.now() - 90 * 86_400_000));
      for (const k of Object.keys(all)) if (all[k].date < cutoff) delete all[k];
      await store.set({ [USAGE_KEY]: all });
      return cur;
    },
    async all() {
      return Object.values(await read());
    },
    /** Saved running context of a chat. @param {string} chatId @returns {Promise<Range | null>} */
    async chatContext(chatId) {
      if (!chatId) return null;
      return ((await store.get(CHATS_KEY))[CHATS_KEY] ?? {})[chatId] ?? null;
    },
    /** @param {string} chatId @param {Range} context */
    async saveChatContext(chatId, context) {
      if (!chatId) return;
      const chats = (await store.get(CHATS_KEY))[CHATS_KEY] ?? {};
      chats[chatId] = { low: Math.round(context.low), high: Math.round(context.high), at: Date.now() };
      // Keep the 200 most recent chats.
      const keep = Object.entries(chats).sort((a, b) => b[1].at - a[1].at).slice(0, 200);
      await store.set({ [CHATS_KEY]: Object.fromEntries(keep) });
    },
    /** @returns {Promise<Record<string, Range & { percent: number, at: number }>>} */
    async detectedProjects() {
      return (await store.get(PROJECT_FILES_KEY))[PROJECT_FILES_KEY] ?? {};
    },
    /** @param {string} project @param {number} percent @param {Range} tokens */
    async saveDetectedProject(project, percent, tokens) {
      const all = (await store.get(PROJECT_FILES_KEY))[PROJECT_FILES_KEY] ?? {};
      const prev = all[project];
      if (prev && prev.percent === percent && prev.low === tokens.low && prev.high === tokens.high) return;
      all[project] = { percent, low: tokens.low, high: tokens.high, at: Date.now() };
      await store.set({ [PROJECT_FILES_KEY]: all });
    },
  };
}

/**
 * Turn day/project totals into shared usage records for syncing (one record per day and project; the
 * server replaces it on each sync because the totals are cumulative for the day). Numbers only.
 * @param {DayProject[]} rows
 * @param {string} user
 */
export function toUsageRecords(rows, user) {
  return rows.map((r) => ({
    user,
    project: r.project,
    sessionId: `ext:${r.date}:${r.project}`.slice(0, 200),
    date: r.date,
    source: /** @type {const} */ ('extension'),
    messages: r.messages,
    estimatedTokens: r.typedTokens,
    processedTokensLow: r.processedLow,
    processedTokensHigh: r.processedHigh,
    isEstimate: /** @type {const} */ (true),
  }));
}

/**
 * Totals for the last N days (oldest first, zero-filled) and per project.
 * @param {DayProject[]} rows
 * @param {{ days?: number, today?: Date }} [o]
 */
export function summarise(rows, o = {}) {
  const days = o.days ?? 7;
  const today = o.today ?? new Date();
  const sum = (list) => ({
    messages: list.reduce((s, r) => s + r.messages, 0),
    typed: list.reduce((s, r) => s + r.typedTokens, 0),
    processed: { low: list.reduce((s, r) => s + r.processedLow, 0), high: list.reduce((s, r) => s + r.processedHigh, 0) },
  });
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = localDate(new Date(today.getFullYear(), today.getMonth(), today.getDate() - i));
    out.push({ date: d, ...sum(rows.filter((r) => r.date === d)) });
  }
  const from = out[0].date;
  const byProject = new Map();
  for (const r of rows.filter((x) => x.date >= from)) {
    if (!byProject.has(r.project)) byProject.set(r.project, []);
    byProject.get(r.project).push(r);
  }
  const projects = [...byProject.entries()].map(([project, list]) => ({ project, ...sum(list) })).sort((a, b) => b.processed.high - a.processed.high || b.typed - a.typed);
  return { days: out, projects, week: sum(rows.filter((x) => x.date >= from)) };
}
