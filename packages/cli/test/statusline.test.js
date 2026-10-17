import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { isolateHome, tempDir } from './helpers.js';
import { installStatusline, uninstallStatusline, claudeSettingsPath } from '../src/plugin/statusline.js';

let claudeDir;
beforeEach(async () => {
  await isolateHome();
  claudeDir = await tempDir('claude-cfg-');
  process.env.CLAUDE_CONFIG_DIR = claudeDir; // never touch the real ~/.claude
});
afterEach(() => {
  delete process.env.CLAUDE_CONFIG_DIR;
});

const settings = async () => JSON.parse(await fs.readFile(claudeSettingsPath(), 'utf8'));

describe('resync statusline install', () => {
  it('copies the script, keeps other settings, and backs up the file', async () => {
    await fs.writeFile(path.join(claudeDir, 'settings.json'), JSON.stringify({ theme: 'dark', permissions: { allow: ['Read'] } }));
    const r = await installStatusline();
    const s = await settings();
    expect(s.theme).toBe('dark');
    expect(s.permissions).toEqual({ allow: ['Read'] });
    expect(s.statusLine).toMatchObject({ type: 'command', padding: 0 });
    expect(s.statusLine.command).toMatch(/^node ".*\/bin\/statusline\.mjs"$/);
    expect(s.statusLine.command).not.toContain('\\');
    await fs.access(path.join(process.env.RESYNC_HOME, 'bin', 'statusline.mjs'));
    await fs.access(path.join(process.env.RESYNC_HOME, 'bin', 'lib.mjs'));
    expect(JSON.parse(await fs.readFile(r.backup, 'utf8')).theme).toBe('dark');
  });

  it("refuses to replace someone else's statusline without --force", async () => {
    await fs.writeFile(path.join(claudeDir, 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command: '~/my-line.sh' } }));
    await expect(installStatusline()).rejects.toThrow(/--force/);
    const r = await installStatusline({ force: true });
    expect(r.replaced).toEqual({ type: 'command', command: '~/my-line.sh' });
  });

  it('creates settings.json when missing, reinstalls idempotently, and uninstalls', async () => {
    await installStatusline();
    await installStatusline();
    expect((await settings()).statusLine).toBeTruthy();
    expect((await uninstallStatusline()).removed).toBe(true);
    expect((await settings()).statusLine).toBeUndefined();
    expect((await uninstallStatusline()).removed).toBe(false);
  });

  it('does not overwrite an unreadable settings file', async () => {
    await fs.writeFile(path.join(claudeDir, 'settings.json'), '{ broken');
    await expect(installStatusline()).rejects.toThrow(/Could not read/);
    expect(await fs.readFile(path.join(claudeDir, 'settings.json'), 'utf8')).toBe('{ broken');
  });
});
