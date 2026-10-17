// Read a Claude Code session transcript for API mode.
// The JSONL entry format is internal to Claude Code and changes between versions (docs/VERIFIED.md),
// so this reader is deliberately defensive: it keeps only plain text from user and assistant turns.
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** ~/.claude/projects (respects CLAUDE_CONFIG_DIR). */
export function claudeProjectsDir() {
  return path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');
}

/** Project folder name: cwd with non-alphanumeric characters replaced by "-" (verified). @param {string} cwd */
export function projectDirName(cwd) {
  return path.resolve(cwd).replace(/[^A-Za-z0-9]/g, '-');
}

/**
 * Newest transcript for a working directory, or for a given session id.
 * @param {{ cwd: string, sessionId?: string }} o
 * @returns {Promise<string | null>}
 */
export async function findTranscript(o) {
  const root = claudeProjectsDir();
  const want = projectDirName(o.cwd);
  let dirs;
  try {
    dirs = (await fs.readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return null;
  }
  // Long paths are truncated (plus a hash), so also accept a prefix match.
  const candidates = dirs.filter((d) => d === want || (want.length > 200 && d.startsWith(want.slice(0, 200))));
  const searchIn = o.sessionId ? dirs : candidates;
  let best = null;
  for (const d of searchIn) {
    const dir = path.join(root, d);
    for (const f of await fs.readdir(dir).catch(() => [])) {
      if (!f.endsWith('.jsonl')) continue;
      if (o.sessionId && f !== `${o.sessionId}.jsonl`) continue;
      const full = path.join(dir, f);
      const st = await fs.stat(full);
      if (!best || st.mtimeMs > best.mtime) best = { file: full, mtime: st.mtimeMs };
    }
  }
  return best?.file ?? null;
}

/**
 * Extract { role, content } messages from transcript JSONL text.
 * @param {string} jsonl
 * @returns {{ role: 'user' | 'assistant', content: string }[]}
 */
export function parseTranscript(jsonl) {
  const out = [];
  for (const line of String(jsonl).split(/\r?\n/)) {
    if (!line.trim()) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.isSidechain || e.isMeta || e.isCompactSummary) continue;
    const msg = e.message ?? e;
    const role = msg.role ?? e.type;
    if (role !== 'user' && role !== 'assistant') continue;
    const text = contentText(msg.content);
    if (!text.trim()) continue;
    // Skip slash-command plumbing and hook/system reminders injected as user turns.
    if (role === 'user' && /^<(command-|local-command|system-reminder)/.test(text.trim())) continue;
    const last = out.at(-1);
    if (last && last.role === role) last.content += `\n\n${text}`;
    else out.push({ role, content: text });
  }
  return out;
}

/** @param {unknown} c */
function contentText(c) {
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return '';
  // Only text blocks; tool calls, tool results and thinking are left out.
  return c.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n');
}

/**
 * Load messages from a transcript file. A non-JSONL file (e.g. a /export text file) becomes one user message.
 * @param {string} file
 */
export async function loadTranscript(file) {
  const text = await fs.readFile(file, 'utf8');
  if (file.endsWith('.jsonl')) {
    const msgs = parseTranscript(text);
    if (msgs.length) return msgs;
    throw new Error(`No conversation text found in ${file}. The transcript format may have changed; export the conversation with /export and pass --transcript <file>.`);
  }
  return [{ role: /** @type {const} */ ('user'), content: text }];
}
