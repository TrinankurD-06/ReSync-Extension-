// `resync usage`: per-day and per-project tables from ~/.resync/usage.jsonl. Everything is an estimate.
import { aggregateUsage, localDate } from '@resync/shared/usage';

/**
 * Render a simple aligned text table.
 * @param {string[]} headers
 * @param {(string | number)[][]} rows
 * @param {('left' | 'right')[]} [align]
 */
export function table(headers, rows, align = []) {
  const cells = [headers, ...rows.map((r) => r.map(String))];
  const widths = headers.map((_, i) => Math.max(...cells.map((r) => r[i].length)));
  const fmt = (r) => r.map((c, i) => (align[i] === 'right' ? c.padStart(widths[i]) : c.padEnd(widths[i]))).join('  ').trimEnd();
  return [fmt(headers), widths.map((w) => '-'.repeat(w)).join('  '), ...cells.slice(1).map(fmt)].join('\n');
}

/** @param {number} n */
export function fmtTokens(n) {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : n >= 10_000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n));
}

/**
 * Build the `resync usage` text.
 * @param {import('@resync/shared/usage').UsageRecord[]} records
 * @param {{ days?: number, project?: string, today?: Date }} [opts]
 */
export function usageReport(records, opts = {}) {
  const days = opts.days ?? 14;
  const today = opts.today ?? new Date();
  const from = localDate(new Date(today.getFullYear(), today.getMonth(), today.getDate() - (days - 1)));
  const recs = records.filter((r) => r.date >= from && (!opts.project || r.project === opts.project));
  if (!recs.length) {
    return `No usage recorded in the last ${days} day(s)${opts.project ? ` for ${opts.project}` : ''}.\nUsage is recorded by the Claude Code plugin's session-end hook and by queued tasks.`;
  }
  const money = (n) => (n ? `$${n.toFixed(2)}` : '-');
  const row = (g) => [g.key, g.sessions, fmtTokens(g.tokens), money(g.costUsd)];
  const byDay = aggregateUsage(recs, (r) => r.date);
  const byProject = aggregateUsage(recs, (r) => r.project).sort((a, b) => b.tokens - a.tokens);
  const total = aggregateUsage(recs, () => 'Total')[0];
  const right = /** @type {const} */ (['left', 'right', 'right', 'right']);
  return [
    `Usage, last ${days} day(s) (ESTIMATE of what was used; not a view of plan limits)`,
    '',
    'Per day',
    table(['Date', 'Sessions', 'Tokens (est.)', 'Cost (est.)'], [...byDay.map(row), row(total)], right),
    '',
    'Per project',
    table(['Project', 'Sessions', 'Tokens (est.)', 'Cost (est.)'], byProject.map(row), right),
  ].join('\n');
}

/**
 * Today's totals, used by the statusline.
 * @param {import('@resync/shared/usage').UsageRecord[]} records
 * @param {Date} [today]
 */
export function todayTotals(records, today = new Date()) {
  const d = localDate(today);
  const g = aggregateUsage(records.filter((r) => r.date === d), () => d)[0];
  return { tokens: g?.tokens ?? 0, costUsd: g?.costUsd ?? 0, sessions: g?.sessions ?? 0 };
}
