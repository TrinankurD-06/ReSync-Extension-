#!/usr/bin/env node
// ReSync plugin hooks. Never calls an AI. Input JSON shapes: docs/VERIFIED.md ("Hooks").
//   pre-compact   : save a marker (session id, transcript path, time). PreCompact output is not shown to
//                   the user (verified), so the reminder is delivered by session-start below.
//   session-start : (matcher "compact") if a marker exists, add context asking Claude to remind the user
//                   to run /resync:passport.
//   session-end   : hand the input to a detached worker that appends a usage record (SessionEnd has a
//                   1.5 s budget, verified), then exit at once.
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readStdin, parseJson, files, safeId, writeJson, readJson } from './lib.mjs';

const MARKER_MAX_AGE_MS = 30 * 60_000;

/** @param {any} input */
export async function preCompact(input) {
  const marker = {
    sessionId: input?.session_id ?? null,
    transcriptPath: input?.transcript_path ?? null,
    cwd: input?.cwd ?? null,
    trigger: input?.trigger ?? null,
    time: new Date().toISOString(),
    reminded: false,
  };
  await writeJson(path.join(files.markers(), `${safeId(marker.sessionId)}.json`), marker);
  return null; // nothing to print: PreCompact output is discarded
}

/** @param {any} input */
export async function sessionStart(input) {
  if (input?.source && input.source !== 'compact') return null;
  const file = path.join(files.markers(), `${safeId(input?.session_id)}.json`);
  let marker = await readJson(file);
  let markerFile = file;
  if (!marker) {
    // The id can differ after compaction in some versions; fall back to the newest recent marker.
    const recent = await newestMarker();
    if (recent) ({ marker, file: markerFile } = recent);
  }
  if (!marker || marker.reminded || Date.now() - Date.parse(marker.time) > MARKER_MAX_AGE_MS) return null;
  await writeJson(markerFile, { ...marker, reminded: true, remindedAt: new Date().toISOString() });
  return {
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext:
        `ReSync: this conversation was just compacted (${marker.trigger ?? 'unknown'} trigger), so earlier detail may be lost. ` +
        'At the start of your next reply, remind the user in one short line that they can run /resync:passport to save a handoff brief ' +
        '(and /resync:resume <file> to continue from one in a fresh session). Do not write the passport unless they ask.',
    },
  };
}

async function newestMarker() {
  let names;
  try {
    names = await fs.readdir(files.markers());
  } catch {
    return null;
  }
  let best = null;
  for (const n of names.filter((n) => n.endsWith('.json'))) {
    const file = path.join(files.markers(), n);
    const m = await readJson(file);
    if (m?.time && (!best || m.time > best.marker.time)) best = { marker: m, file };
  }
  return best;
}

/** @param {any} input @param {{ spawnWorker?: (file: string) => void }} [o] */
export async function sessionEnd(input, o = {}) {
  const file = path.join(files.pending(), `${safeId(input?.session_id)}-${Date.now()}.json`);
  await writeJson(file, { ...input, endedAt: new Date().toISOString() });
  (o.spawnWorker ?? spawnWorker)(file);
  return null;
}

/** @param {string} file */
function spawnWorker(file) {
  const worker = path.join(path.dirname(fileURLToPath(import.meta.url)), 'usage-worker.mjs');
  const child = spawn(process.execPath, [worker, file], { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
}

const HANDLERS = { 'pre-compact': preCompact, 'session-start': sessionStart, 'session-end': sessionEnd };

async function main() {
  const handler = HANDLERS[process.argv[2]];
  if (!handler) {
    console.error(`resync hook: unknown event "${process.argv[2]}"`);
    process.exit(1);
  }
  const input = parseJson(await readStdin());
  try {
    const out = await handler(input);
    if (out) process.stdout.write(JSON.stringify(out));
  } catch (e) {
    // Never block Claude Code because of ReSync: report and exit non-blocking (code 1).
    console.error(`resync hook ${process.argv[2]} failed: ${e?.message ?? e}`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
