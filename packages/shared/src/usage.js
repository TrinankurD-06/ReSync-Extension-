// Usage records: NUMBERS ONLY. No prompt text, no conversation content, no keys.
// Every figure is an estimate of what was used, not a view of plan limits.
import { z } from 'zod';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const nonNeg = z.number().finite().min(0);

export const usageRecordSchema = z
  .object({
    user: z.string().min(1).max(200),
    project: z.string().min(1).max(300),
    sessionId: z.string().min(1).max(200),
    date: z.string().regex(DATE_RE, 'date must be YYYY-MM-DD'),
    source: z.enum(['cli', 'plugin', 'queue', 'extension']),
    model: z.string().max(200).optional(),
    inputTokens: nonNeg.optional(),
    outputTokens: nonNeg.optional(),
    cacheReadTokens: nonNeg.optional(),
    cacheCreationTokens: nonNeg.optional(),
    costUsd: nonNeg.optional(),
    messages: nonNeg.optional(),
    estimatedTokens: nonNeg.optional(),
    durationMs: nonNeg.optional(),
    isEstimate: z.literal(true).default(true),
  })
  .strict();

/** @typedef {z.infer<typeof usageRecordSchema>} UsageRecord */

/**
 * Validate a usage record. Unknown fields are rejected so content can never sneak in.
 * @param {unknown} rec
 * @returns {{ ok: true, record: UsageRecord, errors: [] } | { ok: false, errors: string[] }}
 */
export function validateUsageRecord(rec) {
  const r = usageRecordSchema.safeParse(rec);
  if (r.success) return { ok: true, record: r.data, errors: [] };
  return { ok: false, errors: r.error.issues.map((i) => `${i.path.join('.') || 'record'}: ${i.message}`) };
}

/**
 * Local calendar date as YYYY-MM-DD.
 * @param {Date} [d]
 */
export function localDate(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * Total tokens in a record: real counts when present, else the estimate.
 * @param {Partial<UsageRecord>} r
 */
export function recordTokens(r) {
  const real = (r.inputTokens ?? 0) + (r.outputTokens ?? 0) + (r.cacheReadTokens ?? 0) + (r.cacheCreationTokens ?? 0);
  return real > 0 ? real : (r.estimatedTokens ?? 0);
}

/**
 * Group records and sum their numbers.
 * @param {Partial<UsageRecord>[]} records
 * @param {(r: Partial<UsageRecord>) => string} keyFn
 * @returns {{ key: string, sessions: number, tokens: number, costUsd: number, messages: number }[]}
 */
export function aggregateUsage(records, keyFn) {
  /** @type {Map<string, { key: string, sessions: Set<string>, tokens: number, costUsd: number, messages: number }>} */
  const groups = new Map();
  for (const r of records) {
    const key = keyFn(r);
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { key, sessions: new Set(), tokens: 0, costUsd: 0, messages: 0 }));
    if (r.sessionId) g.sessions.add(r.sessionId);
    g.tokens += recordTokens(r);
    g.costUsd += r.costUsd ?? 0;
    g.messages += r.messages ?? 0;
  }
  return [...groups.values()]
    .map((g) => ({ key: g.key, sessions: g.sessions.size, tokens: g.tokens, costUsd: g.costUsd, messages: g.messages }))
    .sort((a, b) => (a.key < b.key ? 1 : a.key > b.key ? -1 : 0));
}

/**
 * Last N calendar days (oldest first) with totals, zero-filled, for charts.
 * @param {Partial<UsageRecord>[]} records
 * @param {number} [days]
 * @param {Date} [today]
 */
export function lastNDays(records, days = 7, today = new Date()) {
  const byDate = new Map(aggregateUsage(records, (r) => r.date ?? '').map((g) => [g.key, g]));
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
    const key = localDate(d);
    const g = byDate.get(key);
    out.push({ date: key, tokens: g?.tokens ?? 0, messages: g?.messages ?? 0, costUsd: g?.costUsd ?? 0 });
  }
  return out;
}
