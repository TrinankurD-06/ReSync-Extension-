// Runner: Claude Code headless mode (`claude -p`). Flags verified against the CLI reference and
// `claude --help` (docs/VERIFIED.md, "Headless").
import { spawn } from 'node:child_process';
import { resolveExecutable } from '../../util/exec.js';

const REPORT_INSTRUCTIONS = [
  'You are running unattended from the ReSync work queue, inside a dedicated git worktree on its own branch.',
  'Work only inside the current directory. Do not push, merge, or switch branches.',
  'When you finish, end your reply with a short report: what you did, and one line starting with "Tests run:"',
  'naming the test command and its result (or "Tests run: none").',
].join(' ');

/**
 * Build the claude CLI arguments for a task.
 * @param {{ task: string, tools: string[], skipPermissions: boolean }} t
 */
export function buildArgs(t) {
  const args = ['-p', t.task, '--output-format', 'json', '--append-system-prompt', REPORT_INSTRUCTIONS];
  if (t.skipPermissions) {
    args.push('--dangerously-skip-permissions');
  } else {
    // Explicit allowlist; anything that would need approval is denied automatically (no one is there to answer).
    if (t.tools.length) args.push('--allowedTools', t.tools.join(','));
    args.push('--permission-prompts', 'none');
  }
  return args;
}

/**
 * Parse `--output-format json` stdout. Success results have `result`; error subtypes do not.
 * @param {string} stdout
 */
export function parseResult(stdout) {
  const text = String(stdout).trim();
  if (!text) return null;
  const start = text.lastIndexOf('\n{') + 1; // last JSON object if anything was printed before it
  for (const candidate of [text, text.slice(start)]) {
    try {
      const j = JSON.parse(candidate);
      if (j && typeof j === 'object' && j.type === 'result') return j;
    } catch {
      /* try next */
    }
  }
  return null;
}

/** @param {string | undefined} text */
export function extractTestsRun(text) {
  const m = /^\s*(?:[-*]\s*)?\**tests run:?\**\s*(.+)$/im.exec(String(text ?? ''));
  return m ? m[1].trim() : undefined;
}

/** @type {import('./index.js').Runner} */
export default {
  name: 'claude-code',
  description: 'Claude Code headless mode (claude -p) with an explicit tool allowlist',

  async check(config) {
    const exe = await resolveExecutable(config.queue.claudeCommand || 'claude');
    if (!exe) return { ok: false, detail: `Could not find "${config.queue.claudeCommand}" on PATH. Install Claude Code or set queue.claudeCommand.` };
    return { ok: true, detail: exe };
  },

  async run(input) {
    const exe = await resolveExecutable(input.config.queue.claudeCommand || 'claude');
    if (!exe) throw new Error(`Claude Code not found ("${input.config.queue.claudeCommand}"). Install it or set queue.claudeCommand in ~/.resync/config.json.`);
    const args = buildArgs(input);
    input.log(`$ ${exe} ${args.map((a) => (a.length > 80 ? JSON.stringify(a.slice(0, 77) + '...') : JSON.stringify(a))).join(' ')}\n`);

    return new Promise((resolve, reject) => {
      // No --cwd flag exists: the working directory is the process cwd (verified).
      const child = spawn(exe, args, { cwd: input.cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        input.log(`\n[resync] timed out after ${Math.round(input.timeoutMs / 60000)} min; stopping the run\n`);
        child.kill('SIGTERM');
      }, input.timeoutMs);
      const onAbort = () => child.kill('SIGTERM');
      input.signal?.addEventListener('abort', onAbort, { once: true });

      child.stdout.on('data', (d) => {
        stdout += d;
        input.log(d.toString());
      });
      child.stderr.on('data', (d) => {
        stderr += d;
        input.log(d.toString());
      });
      child.on('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        input.signal?.removeEventListener('abort', onAbort);
        const r = parseResult(stdout);
        const resultText = typeof r?.result === 'string' ? r.result : undefined;
        const errorText = Array.isArray(r?.errors) ? r.errors.join('\n') : '';
        const success = code === 0 && Boolean(r) && r.is_error !== true && (r.subtype ?? 'success') === 'success';
        resolve({
          success,
          exitCode: code,
          output: [resultText ?? '', errorText, stderr, r ? '' : stdout].filter(Boolean).join('\n'),
          resultText,
          testsRun: extractTestsRun(resultText),
          usage: r
            ? {
                costUsd: num(r.total_cost_usd),
                inputTokens: num(r.usage?.input_tokens),
                outputTokens: num(r.usage?.output_tokens),
                cacheReadTokens: num(r.usage?.cache_read_input_tokens),
                cacheCreationTokens: num(r.usage?.cache_creation_input_tokens),
                durationMs: num(r.duration_ms),
                sessionId: typeof r.session_id === 'string' ? r.session_id : undefined,
                model: r.modelUsage && typeof r.modelUsage === 'object' ? Object.keys(r.modelUsage)[0] : undefined,
              }
            : undefined,
        });
      });
    });
  },
};

/** @param {unknown} v */
function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}
