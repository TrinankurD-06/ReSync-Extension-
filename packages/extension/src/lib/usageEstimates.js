// Usage ESTIMATES from the extension: messages sent and estimated tokens per day and project.
// Numbers only: no message text is stored. Synced to the team server as usage records (source "extension").
import { localDate } from '@resync/shared/usage';

export const USAGE_KEY = 'resync.usage';

/**
 * @typedef {{ date: string, project: string, messages: number, estimatedTokens: number }} DayProject
 * @param {{ get(k: string): Promise<Record<string, any>>, set(o: Record<string, any>): Promise<void> }} [area]
 */
export function createUsageStore(area) {
  const store = area ?? chrome.storage.local;
  const read = async () => /** @type {Record<string, DayProject>} */ ((await store.get(USAGE_KEY))[USAGE_KEY] ?? {});
  return {
    /**
     * Add to today's totals for a project.
     * @param {{ project: string, messages?: number, tokens?: number, date?: Date }} e
     */
    async add(e) {
      const date = localDate(e.date ?? new Date());
      const project = (e.project || 'No project').slice(0, 120);
      const all = await read();
      const key = `${date}|${project}`;
      const cur = all[key] ?? { date, project, messages: 0, estimatedTokens: 0 };
      cur.messages += Math.max(0, e.messages ?? 0);
      cur.estimatedTokens += Math.max(0, Math.round(e.tokens ?? 0));
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
  };
}

/**
 * Turn day/project totals into shared usage records for syncing (one record per day and project; the
 * server replaces it on each sync because the totals are cumulative for the day).
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
    estimatedTokens: r.estimatedTokens,
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
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = localDate(new Date(today.getFullYear(), today.getMonth(), today.getDate() - i));
    const day = rows.filter((r) => r.date === d);
    out.push({ date: d, messages: day.reduce((s, r) => s + r.messages, 0), tokens: day.reduce((s, r) => s + r.estimatedTokens, 0) });
  }
  const from = out[0].date;
  const byProject = new Map();
  for (const r of rows.filter((x) => x.date >= from)) {
    const p = byProject.get(r.project) ?? { project: r.project, messages: 0, tokens: 0 };
    p.messages += r.messages;
    p.tokens += r.estimatedTokens;
    byProject.set(r.project, p);
  }
  return { days: out, projects: [...byProject.values()].sort((a, b) => b.tokens - a.tokens) };
}
