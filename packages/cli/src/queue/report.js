// Queue task reports: <repo>/.resync/queue-reports/<task-id>.md
import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * @param {{
 *   task: import('./store.js').QueueTask,
 *   outcome: 'done' | 'failed' | 'waiting-for-reset',
 *   branch?: string, worktree?: string,
 *   filesChanged: string[],
 *   testsRun?: string,
 *   resultText?: string,
 *   error?: string,
 *   retry?: { notBefore: Date, reason: string },
 *   usage?: { costUsd?: number, inputTokens?: number, outputTokens?: number, durationMs?: number },
 *   startedAt: Date, finishedAt: Date,
 *   logFile?: string,
 * }} r
 */
export function renderReport(r) {
  const lines = [
    `# ReSync queue report: ${r.task.id}`,
    '',
    `- **Task:** ${r.task.task}`,
    r.task.prompt ? `- **Saved prompt:** ${r.task.prompt}` : null,
    `- **Result:** ${r.outcome}`,
    `- **Runner:** ${r.task.runner}`,
    r.branch ? `- **Branch:** \`${r.branch}\` (not merged, not pushed)` : null,
    r.worktree ? `- **Worktree:** \`${r.worktree}\`` : null,
    `- **Started:** ${r.startedAt.toISOString()}`,
    `- **Finished:** ${r.finishedAt.toISOString()} (${Math.round((r.finishedAt.getTime() - r.startedAt.getTime()) / 1000)} s)`,
    `- **Tools allowed:** ${r.task.skipPermissions ? '**all (skip-permissions was opted in for this task)**' : r.task.tools.map((t) => `\`${t}\``).join(', ')}`,
    r.logFile ? `- **Log:** \`${r.logFile}\`` : null,
    '',
    '## What was done',
    '',
    r.resultText?.trim() || (r.error ? `The task did not complete: ${r.error}` : 'No summary was returned by the runner.'),
    '',
    '## Files changed',
    '',
    r.filesChanged.length ? r.filesChanged.map((f) => `- \`${f}\``).join('\n') : 'None.',
    '',
    '## Tests run',
    '',
    r.testsRun || 'Not reported.',
    '',
  ];
  if (r.retry) lines.push('## Retry', '', `Waiting for the usage limit to reset: ${r.retry.reason}. Next attempt after ${r.retry.notBefore.toLocaleString()}.`, '');
  if (r.usage && (r.usage.costUsd != null || r.usage.inputTokens != null)) {
    lines.push(
      '## Usage (estimate)',
      '',
      `- Tokens: ${(r.usage.inputTokens ?? 0) + (r.usage.outputTokens ?? 0)} (${r.usage.inputTokens ?? 0} in, ${r.usage.outputTokens ?? 0} out)`,
      r.usage.costUsd != null ? `- Cost estimate: $${r.usage.costUsd.toFixed(4)} (as reported by the runner; not a view of plan limits)` : '',
      '',
    );
  }
  if (r.branch) {
    lines.push('## Next steps', '', '```sh', `git log ${r.branch}            # review the work`, `git diff HEAD...${r.branch}      # see the changes`, `git worktree remove "${r.worktree}"   # clean up when done`, '```', '');
  }
  return lines.filter((l) => l !== null).join('\n');
}

/**
 * Write the report into the repo's .resync/queue-reports folder.
 * @param {string} repoRoot
 * @param {string} taskId
 * @param {string} markdown
 */
export async function writeReport(repoRoot, taskId, markdown) {
  const dir = path.join(repoRoot, '.resync', 'queue-reports');
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${taskId}.md`);
  await fs.writeFile(file, markdown, 'utf8');
  return file;
}
