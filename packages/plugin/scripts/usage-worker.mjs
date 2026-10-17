#!/usr/bin/env node
// Detached worker started by the SessionEnd hook: builds one usage record (numbers only) and appends it to
// ~/.resync/usage.jsonl. Sources, all labelled as estimates:
//   - cost and model: the statusline snapshot for this session (statusline input has cost.total_cost_usd)
//   - tokens: summed from per-message usage in the transcript when present (the transcript format is
//     internal to Claude Code, so this is best-effort), else estimated from text length (chars / 4)
// Totals are cumulative across resumes, so only the increase since the last record is appended.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { files, safeId, readJson, writeJson, appendUsage, localDate, resyncUser } from './lib.mjs';

/**
 * Sum token usage from transcript JSONL text.
 * @param {string} jsonl
 */
export function transcriptTotals(jsonl) {
  const byMessage = new Map();
  let chars = 0;
  let userMessages = 0;
  let model;
  for (const line of String(jsonl).split(/\r?\n/)) {
    if (!line.trim()) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.isSidechain) continue;
    const msg = e.message ?? {};
    const role = msg.role ?? e.type;
    const content = msg.content;
    const text = typeof content === 'string' ? content : Array.isArray(content) ? content.map((b) => (typeof b?.text === 'string' ? b.text : '')).join('') : '';
    chars += text.length;
    if (role === 'user' && text.trim() && !e.isMeta) userMessages++;
    if (role === 'assistant' && msg.usage && typeof msg.usage === 'object') {
      // Streaming can log several entries for one message; keep the last per message id.
      byMessage.set(msg.id ?? e.uuid ?? byMessage.size, msg.usage);
      if (typeof msg.model === 'string') model = msg.model;
    }
  }
  const t = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
  for (const u of byMessage.values()) {
    t.inputTokens += num(u.input_tokens);
    t.outputTokens += num(u.output_tokens);
    t.cacheReadTokens += num(u.cache_read_input_tokens);
    t.cacheCreationTokens += num(u.cache_creation_input_tokens);
  }
  const hasReal = byMessage.size > 0;
  return { ...(hasReal ? t : {}), estimatedTokens: hasReal ? undefined : Math.ceil(chars / 4), messages: userMessages, model };
}

/** @param {unknown} v */
function num(v) {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
}

/** Subtract previously recorded totals so resumed sessions are not double counted. */
export function delta(now, before) {
  const out = {};
  for (const [k, v] of Object.entries(now)) {
    if (typeof v !== 'number') continue;
    const d = v - (typeof before?.[k] === 'number' ? before[k] : 0);
    if (d > 0) out[k] = Math.round(d * 1e6) / 1e6;
  }
  return out;
}

/** @param {string} pendingFile */
export async function processPending(pendingFile) {
  const input = await readJson(pendingFile);
  if (!input?.session_id) {
    await fs.rm(pendingFile, { force: true });
    return null;
  }
  const sid = safeId(input.session_id);
  const snapshot = await readJson(path.join(files.sessions(), `${sid}.json`));
  let transcript = '';
  if (input.transcript_path) transcript = await fs.readFile(input.transcript_path, 'utf8').catch(() => '');
  const t = transcriptTotals(transcript);

  const totals = {
    inputTokens: t.inputTokens,
    outputTokens: t.outputTokens,
    cacheReadTokens: t.cacheReadTokens,
    cacheCreationTokens: t.cacheCreationTokens,
    estimatedTokens: t.estimatedTokens,
    messages: t.messages,
    costUsd: typeof snapshot?.costUsd === 'number' ? snapshot.costUsd : undefined,
    durationMs: typeof snapshot?.durationMs === 'number' ? snapshot.durationMs : undefined,
  };
  const recordedFile = path.join(files.sessions(), `${sid}.recorded.json`);
  const before = await readJson(recordedFile);
  const d = delta(totals, before);
  let rec = null;
  if (Object.keys(d).length) {
    const cwd = input.cwd || snapshot?.projectDir || '';
    rec = await appendUsage({
      user: resyncUser(),
      project: snapshot?.project || (cwd ? path.basename(cwd) : 'unknown'),
      sessionId: String(input.session_id),
      date: localDate(input.endedAt ? new Date(input.endedAt) : new Date()),
      model: snapshot?.model || t.model,
      ...d,
    });
    await writeJson(recordedFile, { ...totals, at: new Date().toISOString() });
  }
  await fs.rm(pendingFile, { force: true });
  return rec;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  processPending(process.argv[2]).catch(() => process.exit(1));
}
