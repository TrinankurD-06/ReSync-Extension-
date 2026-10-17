#!/usr/bin/env node
// ReSync statusline for Claude Code: model, context used, session cost, and today's total (all estimates).
// Uses only verified statusline input fields (docs/VERIFIED.md, "Statusline"); any of them may be absent.
// Side effect: saves a small per-session snapshot that the SessionEnd usage worker reads for cost.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readStdin, parseJson, files, safeId, writeJson, readJson, localDate } from './lib.mjs';

/** @param {number} n */
export function short(n) {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(Math.round(n));
}

/** @param {number | undefined} usd */
export function money(usd) {
  return typeof usd === 'number' && usd > 0 ? `$${usd < 10 ? usd.toFixed(2) : usd.toFixed(1)}` : '$0';
}

/**
 * Today's totals from usage.jsonl, cached by file size + mtime so each refresh stays cheap.
 * @param {Date} [now]
 */
export async function todayFromLog(now = new Date()) {
  const today = localDate(now);
  let st;
  try {
    st = await fs.stat(files.usage());
  } catch {
    return { tokens: 0, costUsd: 0, sessions: new Set() };
  }
  const cacheFile = path.join(files.sessions(), 'today-cache.json');
  const cache = await readJson(cacheFile);
  if (cache && cache.date === today && cache.size === st.size && cache.mtimeMs === st.mtimeMs) {
    return { tokens: cache.tokens, costUsd: cache.costUsd, sessions: new Set(cache.sessions) };
  }
  const text = await fs.readFile(files.usage(), 'utf8');
  let tokens = 0;
  let costUsd = 0;
  const sessions = new Set();
  for (const line of text.split('\n')) {
    if (!line.includes(today)) continue;
    let r;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    if (r.date !== today) continue;
    const real = (r.inputTokens ?? 0) + (r.outputTokens ?? 0) + (r.cacheReadTokens ?? 0) + (r.cacheCreationTokens ?? 0);
    tokens += real > 0 ? real : (r.estimatedTokens ?? 0);
    costUsd += r.costUsd ?? 0;
    if (r.sessionId) sessions.add(r.sessionId);
  }
  await writeJson(cacheFile, { date: today, size: st.size, mtimeMs: st.mtimeMs, tokens, costUsd, sessions: [...sessions] }).catch(() => {});
  return { tokens, costUsd, sessions };
}

/**
 * Build the status line from the statusline JSON input.
 * @param {any} input
 * @param {{ now?: Date }} [o]
 */
export async function render(input, o = {}) {
  const now = o.now ?? new Date();
  const sid = input?.session_id ? safeId(input.session_id) : null;
  const model = input?.model?.display_name || input?.model?.id || 'Claude';
  const cw = input?.context_window ?? {};
  const ctxTokens = (cw.total_input_tokens ?? 0) + (cw.total_output_tokens ?? 0);
  const pct = typeof cw.used_percentage === 'number' ? cw.used_percentage : null;
  const sessionCost = typeof input?.cost?.total_cost_usd === 'number' ? input.cost.total_cost_usd : undefined;
  const projectDir = input?.workspace?.project_dir || input?.cwd || '';

  // Snapshot for the SessionEnd usage worker (cost is not in the SessionEnd input).
  if (sid) {
    await writeJson(path.join(files.sessions(), `${sid}.json`), {
      costUsd: sessionCost,
      durationMs: typeof input?.cost?.total_duration_ms === 'number' ? input.cost.total_duration_ms : undefined,
      model,
      project: projectDir ? path.basename(projectDir) : undefined,
      projectDir,
      updatedAt: now.toISOString(),
    }).catch(() => {});
  }

  // Today's total = recorded usage + this session's cost not yet recorded.
  const day = await todayFromLog(now);
  let todayCost = day.costUsd;
  if (sid && typeof sessionCost === 'number') {
    const recorded = await readJson(path.join(files.sessions(), `${sid}.recorded.json`));
    todayCost += Math.max(0, sessionCost - (typeof recorded?.costUsd === 'number' ? recorded.costUsd : 0));
  }

  const parts = [
    model,
    `ctx ${short(ctxTokens)}${pct !== null ? ` (${Math.round(pct)}%)` : ''}`,
    `session ${money(sessionCost)}`,
    `today ${money(todayCost)}${day.tokens ? ` ${short(day.tokens)} tok` : ''}`,
  ];
  return `${parts.join(' | ')} (est.)`;
}

async function main() {
  const input = parseJson(await readStdin());
  try {
    process.stdout.write((await render(input)) + '\n');
  } catch {
    process.stdout.write('ReSync (status unavailable)\n');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
