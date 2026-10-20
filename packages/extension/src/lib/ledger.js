// Team Decision Ledger, stored in this browser (chrome.storage.local). Works fully local-only; with a team server and
// ledger sync turned on (off by default, per team), decisions are scrubbed and synced (see syncEngine.js).
// The rules (parsing, similarity, prefilter, prompts, supersede) are in @resync/shared/ledger.
import { decisionSchema, decisionId, decisionsFromPassport, deriveTags, findDuplicate, mergeDecisions, prefilter, supersede as supersedeIn, conflictPrompt, parseConflictAnswer } from '@resync/shared/ledger';

export const LEDGER_KEY = 'resync.ledger';
/** Dismissals per decision ({ chat, at }), the muted list, and model-check timestamps per chat. */
export const FEEDBACK_KEY = 'resync.ledger.feedback';
/** A decision dismissed this many times (in different chats) stops showing in banners until unmuted. */
export const MUTE_AFTER = 3;
/** Model conflict checks per chat: at most one per 20 s and 12 per hour. Local checks are free and not limited. */
export const RATE = { minIntervalMs: 20_000, perHour: 12 };

/**
 * @typedef {import('@resync/shared/ledger').Decision} Decision
 * @typedef {{ get(k: string): Promise<Record<string, any>>, set(o: Record<string, any>): Promise<void> }} Area
 * @typedef {{ dismissals: Record<string, { chat: string, at: number }[]>, muted: string[], checks: Record<string, number[]> }} Feedback
 */

/** @param {Area} [area] @param {{ now?: () => Date }} [o] */
export function createLedger(area, o = {}) {
  const store = area ?? chrome.storage.local;
  const now = o.now ?? (() => new Date());
  /** @returns {Promise<{ decisions: Decision[], dirty: string[] }>} */
  const read = async () => {
    const raw = (await store.get(LEDGER_KEY))[LEDGER_KEY] ?? {};
    return { decisions: raw.decisions ?? [], dirty: raw.dirty ?? [] };
  };
  /** @param {Decision[]} decisions @param {string[]} [changed] ids to push on the next sync */
  const write = async (decisions, changed = []) => {
    const cur = await read();
    await store.set({ [LEDGER_KEY]: { decisions, dirty: [...new Set([...cur.dirty, ...changed])] } });
  };
  /** @returns {Promise<Feedback>} */
  const feedback = async () => ({ dismissals: {}, muted: [], checks: {}, ...((await store.get(FEEDBACK_KEY))[FEEDBACK_KEY] ?? {}) });
  const saveFeedback = (f) => store.set({ [FEEDBACK_KEY]: f });

  return {
    async list() {
      return (await read()).decisions;
    },
    /** @param {string} id */
    async get(id) {
      return (await read()).decisions.find((d) => d.id === id) ?? null;
    },

    /** Manual add from the Ledger tab. @param {{ text: string, reason?: string, author?: string, project?: string, sourceChat?: string, status?: 'active' | 'pending' }} d */
    async add(d) {
      const at = now().toISOString();
      const status = d.status ?? 'active';
      const item = decisionSchema.parse({ id: decisionId(), text: d.text, reason: d.reason ?? '', author: d.author ?? '', project: d.project ?? '', sourceChat: d.sourceChat ?? '', createdAt: at, updatedAt: at, status, tags: deriveTags(`${d.text} ${d.reason ?? ''}`), confirmed: status !== 'pending' });
      await write([item, ...(await read()).decisions], [item.id]);
      return item;
    },

    /** Edit text/reason/project/tags. @param {string} id @param {Partial<Pick<Decision, 'text' | 'reason' | 'project' | 'tags'>>} patch */
    async update(id, patch) {
      const list = (await read()).decisions;
      const d = list.find((x) => x.id === id);
      if (!d) throw new Error('That decision is no longer in the ledger.');
      const next = decisionSchema.parse({ ...d, ...patch, tags: patch.tags ?? (patch.text || patch.reason ? deriveTags(`${patch.text ?? d.text} ${patch.reason ?? d.reason}`) : d.tags), updatedAt: now().toISOString() });
      await write(list.map((x) => (x.id === id ? next : x)), [id]);
      return next;
    },

    /** A teammate confirms a pending decision (optionally correcting it first). @param {string} id @param {{ text?: string, reason?: string }} [correction] */
    async confirm(id, correction = {}) {
      const list = (await read()).decisions;
      const d = list.find((x) => x.id === id);
      if (!d) throw new Error('That decision is no longer in the ledger.');
      const text = correction.text?.trim() || d.text;
      const reason = correction.reason?.trim() ?? d.reason;
      const next = { ...d, text, reason, tags: deriveTags(`${text} ${reason}`), status: /** @type {const} */ ('active'), confirmed: true, updatedAt: now().toISOString() };
      await write(list.map((x) => (x.id === id ? next : x)), [id]);
      return next;
    },

    /** @param {string} id */
    async remove(id) {
      const cur = await read();
      await store.set({ [LEDGER_KEY]: { decisions: cur.decisions.filter((d) => d.id !== id), dirty: cur.dirty.filter((x) => x !== id) } });
    },

    /**
     * Replace a decision: the old one becomes superseded; both are linked (supersededBy / supersedes).
     * @param {string} oldId
     * @param {{ text: string, reason?: string, author?: string, sourceChat?: string }} next
     */
    async supersede(oldId, next) {
      if (!next.text?.trim()) throw new Error('Write the new decision first.');
      const r = supersedeIn((await read()).decisions, oldId, next, now());
      await write(r.list, [oldId, r.created.id]);
      return r.created;
    },

    /**
     * Decisions from a Context Passport. Near-duplicates of an existing decision are merged into it instead of
     * added: locally when the texts are close enough, and for borderline matches only when `confirmSame` (a BYOK
     * model call) says they are the same. Decisions marked (assumed) come in as pending.
     * @param {string} passport
     * @param {{ author?: string, project?: string, sourceChat?: string }} meta
     * @param {{ confirmSame?: (a: Decision, b: Decision) => Promise<boolean | null> }} [o]
     */
    async addFromPassport(passport, meta, o = {}) {
      const incoming = decisionsFromPassport(passport, { ...meta, now: now() });
      let list = (await read()).decisions;
      const added = [];
      const merged = [];
      for (const d of incoming) {
        const dup = findDuplicate(d, list);
        let same = dup?.verdict === 'same';
        if (dup?.verdict === 'maybe' && o.confirmSame) same = (await o.confirmSame(dup.match, d).catch(() => null)) === true;
        if (dup && same) {
          const m = mergeDecisions(dup.match, d, now());
          list = list.map((x) => (x.id === m.id ? m : x));
          merged.push(m);
        } else {
          list = [d, ...list];
          added.push(d);
        }
      }
      await write(list, [...added, ...merged].map((d) => d.id));
      return { added, merged, pending: added.filter((d) => d.status === 'pending').length };
    },

    // ---- Banner feedback ----

    /**
     * "Dismiss" on a banner: never show this decision again in this chat; after MUTE_AFTER dismissals (in different
     * chats) it is muted everywhere, since it keeps being a false positive.
     * @param {string} id @param {string} chat
     * @returns {Promise<{ muted: boolean }>}
     */
    async dismiss(id, chat) {
      const f = await feedback();
      const list = (f.dismissals[id] ??= []);
      if (!list.some((x) => x.chat === chat)) list.push({ chat, at: Date.now() });
      const muted = new Set(list.map((x) => x.chat)).size >= MUTE_AFTER;
      if (muted && !f.muted.includes(id)) f.muted.push(id);
      await saveFeedback(f);
      return { muted };
    },
    /** @param {string} id */
    async unmute(id) {
      const f = await feedback();
      f.muted = f.muted.filter((x) => x !== id);
      delete f.dismissals[id];
      await saveFeedback(f);
    },
    /** Decisions not to show in this chat: muted everywhere, or dismissed here. @param {string} chat */
    async hiddenIn(chat) {
      const f = await feedback();
      return new Set([...f.muted, ...Object.entries(f.dismissals).filter(([, l]) => l.some((x) => x.chat === chat)).map(([id]) => id)]);
    },
    async muted() {
      return (await feedback()).muted;
    },

    /**
     * Take a model-check slot for a chat (rate limit). Returns false when the chat is over the limit.
     * @param {string} chat
     */
    async takeCheckSlot(chat) {
      const f = await feedback();
      const t = Date.now();
      const recent = (f.checks[chat] ?? []).filter((x) => t - x < 3_600_000);
      if (recent.length >= RATE.perHour || (recent.length && t - recent.at(-1) < RATE.minIntervalMs)) return false;
      f.checks[chat] = [...recent, t];
      // Forget chats with no checks in the last hour.
      for (const [k, v] of Object.entries(f.checks)) if (!v.some((x) => t - x < 3_600_000)) delete f.checks[k];
      await saveFeedback(f);
      return true;
    },

    // ---- Sync support ----

    /** Ids changed since the last sync. */
    async dirty() {
      return (await read()).dirty;
    },
    /** @param {string[]} ids */
    async clearDirty(ids) {
      const cur = await read();
      const done = new Set(ids);
      await store.set({ [LEDGER_KEY]: { decisions: cur.decisions, dirty: cur.dirty.filter((x) => !done.has(x)) } });
    },
    /**
     * Merge decisions pulled from the team server: unknown ones are added, known ones take the newer copy (by
     * updatedAt); local changes not yet pushed win.
     * @param {Decision[]} remote
     */
    async mergeRemote(remote) {
      const cur = await read();
      const pendingPush = new Set(cur.dirty);
      const byId = new Map(cur.decisions.map((d) => [d.id, d]));
      let pulled = 0;
      for (const r of remote) {
        const parsed = decisionSchema.safeParse(r);
        if (!parsed.success) continue;
        const local = byId.get(r.id);
        if (local && (pendingPush.has(r.id) || (local.updatedAt ?? local.createdAt) >= (parsed.data.updatedAt ?? parsed.data.createdAt))) continue;
        byId.set(r.id, parsed.data);
        pulled++;
      }
      await store.set({ [LEDGER_KEY]: { decisions: [...byId.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)), dirty: cur.dirty } });
      return pulled;
    },
  };
}

/**
 * The contradiction check for one new message (runs in the background worker).
 * 1. Local prefilter (key terms, tags, project). No candidates: done, no model call.
 * 2. With a BYOK provider for "ledger" (and a free rate-limit slot for this chat): ask the model, which answers in
 *    short JSON; only decisions it calls a conflict are shown.
 * 3. Without one (or if the call fails): show the candidates as "Related team decision", never "conflict".
 * @param {{ text: string, role: 'user' | 'assistant', chat: string, project?: string }} msg
 * @param {{
 *   ledger: ReturnType<typeof createLedger>,
 *   modelEnabled: () => Promise<boolean>,
 *   run?: (req: { feature: 'ledger', system: string, messages: { role: 'user', content: string }[], maxTokens: number }) => Promise<{ ok: boolean, text?: string, error?: any }>,
 * }} deps
 * @returns {Promise<{ alerts: { decision: Decision, relation: 'conflict' | 'related', why: string }[], usedModel: boolean, note?: string }>}
 */
export async function checkMessage(msg, deps) {
  const hidden = await deps.ledger.hiddenIn(msg.chat);
  const candidates = prefilter(msg.text, await deps.ledger.list(), { project: msg.project, muted: hidden });
  if (!candidates.length) return { alerts: [], usedModel: false };
  const decisions = candidates.map((c) => c.decision);
  const related = (note) => ({ alerts: decisions.slice(0, 2).map((decision) => ({ decision, relation: /** @type {const} */ ('related'), why: '' })), usedModel: false, note });
  if (!deps.run || !(await deps.modelEnabled())) return related();
  if (!(await deps.ledger.takeCheckSlot(msg.chat))) return related('Model check skipped: this chat hit the check limit.');
  const prompt = conflictPrompt(msg.text, decisions, { role: msg.role });
  const r = await deps.run({ feature: 'ledger', system: prompt.system, messages: prompt.messages, maxTokens: 300 });
  if (!r.ok) return related(`Model check failed (${r.error?.message ?? 'unknown error'}); showing related decisions instead.`);
  const answer = parseConflictAnswer(r.text ?? '', decisions);
  if (!answer) return related("The model's answer couldn't be read; showing related decisions instead.");
  const byId = new Map(decisions.map((d) => [d.id, d]));
  return { alerts: answer.filter((a) => a.relation === 'conflict').map((a) => ({ decision: byId.get(a.id), relation: /** @type {const} */ ('conflict'), why: a.why })), usedModel: true };
}
