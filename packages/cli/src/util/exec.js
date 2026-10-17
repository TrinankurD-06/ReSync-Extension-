// Find an executable without using a shell (so task text is never re-parsed by cmd.exe or sh).
import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * Resolve a command to an executable path.
 * - Absolute/relative paths are used as-is when they exist.
 * - On Windows, prefers NAME.exe on PATH; for npm-style NAME.cmd shims, reads the shim to find the real
 *   target (Node cannot spawn .cmd files without a shell).
 * @param {string} name
 * @returns {Promise<string | null>}
 */
export async function resolveExecutable(name) {
  if (!name) return null;
  if (name.includes('/') || name.includes('\\')) return (await exists(name)) ? path.resolve(name) : null;
  const dirs = (process.env.PATH ?? process.env.Path ?? '').split(path.delimiter).filter(Boolean);
  const win = process.platform === 'win32';
  for (const dir of dirs) {
    if (win) {
      const exe = path.join(dir, `${name}.exe`);
      if (await exists(exe)) return exe;
      const cmd = path.join(dir, `${name}.cmd`);
      if (await exists(cmd)) {
        const target = await shimTarget(cmd);
        if (target) return target;
      }
    } else {
      const p = path.join(dir, name);
      if (await exists(p)) return p;
    }
  }
  return null;
}

/**
 * Read the target of an npm .cmd shim, e.g. `"%dp0%\node_modules\pkg\bin\tool.exe"   %*`.
 * Only .exe targets are returned (a .js target would need node, which callers can handle separately).
 * @param {string} cmdFile
 */
export async function shimTarget(cmdFile) {
  const text = await fs.readFile(cmdFile, 'utf8').catch(() => '');
  const m = /"%(?:~)?dp0%\\?([^"]+\.exe)"/i.exec(text);
  if (!m) return null;
  const target = path.join(path.dirname(cmdFile), m[1]);
  return (await exists(target)) ? target : null;
}

/** @param {string} p */
async function exists(p) {
  try {
    const s = await fs.stat(p);
    return s.isFile();
  } catch {
    return false;
  }
}
