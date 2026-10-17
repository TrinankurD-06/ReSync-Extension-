// Git worktrees for queued tasks: each task runs in its own worktree on a new branch resync/<task-id>.
// Safety rules (spec 4.5): never touch main (or any existing branch), never push, never merge.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { resyncHome } from '../config.js';

const exec = promisify(execFile);

/**
 * Run git and return trimmed stdout.
 * @param {string} cwd
 * @param {string[]} args
 */
export async function git(cwd, args) {
  try {
    const { stdout } = await exec('git', args, { cwd, maxBuffer: 20 * 1024 * 1024, windowsHide: true });
    return stdout.trim();
  } catch (e) {
    const err = /** @type {any} */ (e);
    throw new Error(`git ${args.join(' ')} failed: ${(err.stderr || err.message || '').toString().trim()}`, { cause: e });
  }
}

/** @param {string} dir */
export async function repoRoot(dir) {
  try {
    return path.resolve(await git(dir, ['rev-parse', '--show-toplevel']));
  } catch (e) {
    throw new Error(`${dir} is not inside a git repository. Queued tasks need a git repo (they run in their own worktree and branch).`, { cause: e });
  }
}

/** @param {string} taskId */
export function branchFor(taskId) {
  if (!/^[A-Za-z0-9._-]+$/.test(taskId)) throw new Error(`Invalid task id for a branch name: ${taskId}`);
  return `resync/${taskId}`;
}

/** Guard used before any git write: only resync/* branches may ever be created or committed to. @param {string} branch */
export function assertReSyncBranch(branch) {
  if (!branch.startsWith('resync/')) throw new Error(`Refusing to touch branch "${branch}": ReSync only writes to resync/* branches.`);
}

/**
 * Where a repo's task worktrees live: <RESYNC_HOME>/worktrees/<repo-name>-<hash>/<task-id>.
 * Kept outside the repo so the main working tree is never modified.
 * @param {string} root
 * @param {string} taskId
 */
export function worktreePath(root, taskId) {
  const hash = crypto.createHash('sha1').update(path.resolve(root).toLowerCase()).digest('hex').slice(0, 8);
  return path.join(resyncHome(), 'worktrees', `${path.basename(root)}-${hash}`, taskId);
}

/**
 * Create (or reuse, on retry) the worktree for a task.
 * @param {string} repo any path inside the repo
 * @param {string} taskId
 * @returns {Promise<{ root: string, worktree: string, branch: string, baseCommit: string, reused: boolean }>}
 */
export async function ensureWorktree(repo, taskId) {
  const root = await repoRoot(repo);
  const branch = branchFor(taskId);
  assertReSyncBranch(branch);
  const wt = worktreePath(root, taskId);
  const existing = await listWorktrees(root);
  const found = existing.find((w) => path.resolve(w.path).toLowerCase() === path.resolve(wt).toLowerCase());
  if (found) {
    const head = await git(wt, ['rev-parse', 'HEAD']);
    return { root, worktree: wt, branch, baseCommit: await readBase(wt, head), reused: true };
  }
  const branches = await git(root, ['branch', '--list', branch]);
  if (branches) throw new Error(`Branch ${branch} already exists without its worktree; remove it or the task.`);
  const baseCommit = await git(root, ['rev-parse', 'HEAD']);
  await fs.mkdir(path.dirname(wt), { recursive: true });
  // New branch from the current commit; the main working tree and its branch are left untouched.
  await git(root, ['worktree', 'add', '-b', branch, wt, baseCommit]);
  await fs.writeFile(path.join(wt, '.git-resync-base'), baseCommit).catch(() => {});
  await excludeLocally(wt, ['.git-resync-base']);
  return { root, worktree: wt, branch, baseCommit, reused: false };
}

/** @param {string} wt @param {string} fallback */
async function readBase(wt, fallback) {
  try {
    return (await fs.readFile(path.join(wt, '.git-resync-base'), 'utf8')).trim() || fallback;
  } catch {
    return fallback;
  }
}

/**
 * Add patterns to the repo's local exclude file (.git/info/exclude), which is never committed.
 * @param {string} dir
 * @param {string[]} patterns
 */
export async function excludeLocally(dir, patterns) {
  const common = await git(dir, ['rev-parse', '--git-common-dir']);
  const file = path.join(path.resolve(dir, common), 'info', 'exclude');
  let current = '';
  try {
    current = await fs.readFile(file, 'utf8');
  } catch {
    /* none yet */
  }
  const missing = patterns.filter((p) => !current.split(/\r?\n/).includes(p));
  if (!missing.length) return;
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, `${current && !current.endsWith('\n') ? '\n' : ''}# added by resync\n${missing.join('\n')}\n`);
}

/** @param {string} root */
export async function listWorktrees(root) {
  const out = await git(root, ['worktree', 'list', '--porcelain']);
  const list = [];
  let cur = null;
  for (const line of out.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) list.push((cur = { path: line.slice(9), branch: '' }));
    else if (line.startsWith('branch ') && cur) cur.branch = line.slice(7).replace(/^refs\/heads\//, '');
  }
  return list;
}

/**
 * Commit anything the task left uncommitted, on its own resync/* branch only.
 * @param {string} wt
 * @param {string} branch
 * @param {string} message
 * @returns {Promise<boolean>} whether a commit was made
 */
export async function commitLeftovers(wt, branch, message) {
  assertReSyncBranch(branch);
  const current = await git(wt, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (current !== branch) throw new Error(`Worktree is on ${current}, expected ${branch}; not committing.`);
  const status = await git(wt, ['status', '--porcelain']);
  if (!status) return false;
  await git(wt, ['add', '-A']);
  // Use the user's git identity; fall back to a neutral one only when none is configured.
  const email = await git(wt, ['config', 'user.email']).catch(() => '');
  const identity = email ? [] : ['-c', 'user.name=ReSync queue', '-c', 'user.email=resync@localhost'];
  // Hooks are respected; if one fails, the changes stay uncommitted in the worktree and the report says so.
  await git(wt, [...identity, 'commit', '-q', '-m', message]);
  return true;
}

/**
 * Files changed on the task branch since it was created.
 * @param {string} wt
 * @param {string} baseCommit
 */
export async function changedFiles(wt, baseCommit) {
  const committed = await git(wt, ['diff', '--name-only', `${baseCommit}..HEAD`]);
  return committed ? committed.split(/\r?\n/).filter(Boolean) : [];
}
