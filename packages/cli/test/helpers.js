// Test helpers: isolated RESYNC_HOME and throwaway git repos.
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export async function tempDir(prefix = 'resync-test-') {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

/** Point RESYNC_HOME at a fresh temp folder; returns it. */
export async function isolateHome() {
  const home = await tempDir('resync-home-');
  process.env.RESYNC_HOME = home;
  process.env.RESYNC_SERVER_URL = '';
  process.env.RESYNC_USER = 'tester';
  return home;
}

/** Create a git repo with one commit on main. */
export async function makeRepo() {
  const dir = await tempDir('resync-repo-');
  const g = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' }).toString().trim();
  g('init', '-q', '-b', 'main');
  g('config', 'user.name', 'Test');
  g('config', 'user.email', 'test@example.com');
  g('config', 'commit.gpgsign', 'false');
  await fs.writeFile(path.join(dir, 'README.md'), '# test\n');
  g('add', '.');
  g('commit', '-q', '-m', 'init');
  return { dir, git: g };
}
