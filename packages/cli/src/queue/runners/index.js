// Runner adapters: how a queued task is executed. `claude-code` is built in; contributors can add
// runners for other coding CLIs by implementing this interface and calling registerRunner.
import claudeCode from './claudeCode.js';

/**
 * @typedef {{
 *   task: string,                 full instruction text (saved prompt + task)
 *   cwd: string,                  the task's worktree; the runner must not leave it
 *   tools: string[],              tool allowlist (runner-specific syntax; Claude Code permission rules for claude-code)
 *   skipPermissions: boolean,     per-task opt-in; the queue has already printed a warning
 *   timeoutMs: number,
 *   log: (chunk: string) => void, append to the task log
 *   signal?: AbortSignal,
 *   config: import('../../config.js').ReSyncConfig,
 * }} RunInput
 *
 * @typedef {{
 *   success: boolean,
 *   exitCode: number | null,
 *   output: string,               everything the tool printed (for limit detection and the log)
 *   resultText?: string,          the agent's final message, if known
 *   testsRun?: string,
 *   usage?: { costUsd?: number, inputTokens?: number, outputTokens?: number, cacheReadTokens?: number, cacheCreationTokens?: number, durationMs?: number, sessionId?: string, model?: string },
 * }} RunResult
 *
 * @typedef {{
 *   name: string,
 *   description: string,
 *   check?: (config: import('../../config.js').ReSyncConfig) => Promise<{ ok: boolean, detail: string }>,
 *   run: (input: RunInput) => Promise<RunResult>,
 * }} Runner
 */

/** @type {Map<string, Runner>} */
const runners = new Map();

/** @param {Runner} r */
export function registerRunner(r) {
  if (!r?.name || typeof r.run !== 'function') throw new Error('A runner needs a name and a run() function.');
  runners.set(r.name, r);
}

/** @param {string} name */
export function getRunner(name) {
  const r = runners.get(name);
  if (!r) throw new Error(`Unknown runner "${name}". Available: ${[...runners.keys()].join(', ')}`);
  return r;
}

export function listRunners() {
  return [...runners.values()].map((r) => ({ name: r.name, description: r.description }));
}

registerRunner(claudeCode);
