// `resync statusline install|uninstall`. A plugin cannot set the main statusLine (verified), so the CLI copies
// the script to ~/.resync/bin and adds the statusLine entry to the user's Claude Code settings.json.
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resyncHome } from '../config.js';
import { pluginSourceDir } from './build.js';

/** Claude Code's user settings file (respects CLAUDE_CONFIG_DIR). */
export function claudeSettingsPath() {
  return path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'settings.json');
}

/** The command written into settings.json. Forward slashes: verified requirement on Windows. */
export function statuslineCommand() {
  const script = path.join(resyncHome(), 'bin', 'statusline.mjs').replace(/\\/g, '/');
  return `node "${script}"`;
}

/** ReSync's own entry: the exact command we write, or any earlier ReSync install (resync folder + statusline.mjs). */
const isOurs = (sl) =>
  typeof sl?.command === 'string' && (sl.command === statuslineCommand() || (/[\\/]bin[\\/]statusline\.mjs"?$/.test(sl.command) && /resync/i.test(sl.command)));

async function readSettings(file) {
  try {
    return { data: JSON.parse(await fs.readFile(file, 'utf8')), existed: true };
  } catch (e) {
    if (/** @type {any} */ (e).code === 'ENOENT') return { data: {}, existed: false };
    throw new Error(`Could not read ${file} as JSON (${/** @type {Error} */ (e).message}). Fix it or add the statusLine entry by hand.`, { cause: e });
  }
}

/**
 * @param {{ force?: boolean }} [o]
 * @returns {Promise<{ settings: string, command: string, backup?: string, replaced?: unknown }>}
 */
export async function installStatusline(o = {}) {
  const bin = path.join(resyncHome(), 'bin');
  await fs.mkdir(bin, { recursive: true });
  for (const f of ['statusline.mjs', 'lib.mjs']) await fs.copyFile(path.join(pluginSourceDir(), 'scripts', f), path.join(bin, f));

  const file = claudeSettingsPath();
  const { data, existed } = await readSettings(file);
  const current = data.statusLine;
  if (current && !isOurs(current) && !o.force) {
    throw new Error(`Claude Code already has a statusLine (${JSON.stringify(current)}). Re-run with --force to replace it (a backup of settings.json is kept).`);
  }
  let backup;
  if (existed) {
    backup = `${file}.resync-backup-${Date.now()}`;
    await fs.copyFile(file, backup);
  }
  const command = statuslineCommand();
  data.statusLine = { type: 'command', command, padding: 0 };
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
  return { settings: file, command, backup, replaced: current && !isOurs(current) ? current : undefined };
}

export async function uninstallStatusline() {
  const file = claudeSettingsPath();
  const { data, existed } = await readSettings(file);
  if (!existed || !isOurs(data.statusLine)) return { removed: false, settings: file };
  await fs.copyFile(file, `${file}.resync-backup-${Date.now()}`);
  delete data.statusLine;
  await fs.writeFile(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
  return { removed: true, settings: file };
}
