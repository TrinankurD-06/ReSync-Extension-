// Extra commands registered on top of the core program (plugin, statusline, login, sync).
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeCommands, loadMergedLibrary, buildLocalPlugin, pluginSourceDir, seedPromptsDir, localMarketplaceDir } from './plugin/build.js';
import { resolveExecutable } from './util/exec.js';
import { installStatusline, uninstallStatusline } from './plugin/statusline.js';
import { promises as fs } from 'node:fs';
import { loadConfig } from './config.js';
import { login, logout, sync, syncClient } from './sync.js';

const exec = promisify(execFile);

/**
 * @param {import('commander').Command} program
 * @param {{ out?: (s: string) => void, fetch?: typeof fetch, sleep?: (ms: number) => Promise<void>, skipPlugin?: boolean }} [io]
 */
export function extendProgram(program, io = {}) {
  const out = io.out ?? ((s) => console.log(s));

  const plugin = program.command('plugin').description('Claude Code plugin: generate and install the /resync: commands');
  plugin
    .command('generate')
    .description('Regenerate commands/ in a plugin folder from a prompt library (used for the repo copy)')
    .option('--from <dir>', 'prompt library folder', seedPromptsDir())
    .option('--out <dir>', 'plugin commands folder', path.join(pluginSourceDir(), 'commands'))
    .action(async (o) => {
      const { prompts, errors } = await loadMergedLibrary([path.resolve(o.from)]);
      for (const e of errors) out(`skipped ${e.file}: ${e.errors.join('; ')}`);
      const r = await writeCommands(path.resolve(o.out), prompts);
      out(`Wrote ${r.written.length} command files to ${path.resolve(o.out)}${r.removed.length ? ` (removed ${r.removed.join(', ')})` : ''}.`);
    });
  plugin
    .command('build')
    .description(`Build the local plugin copy with your synced prompts (${localMarketplaceDir()})`)
    .action(async () => {
      const r = await buildLocalPlugin();
      for (const e of r.errors) out(`skipped ${e.file}: ${e.errors.join('; ')}`);
      out(`Built ${r.pluginDir} with ${r.commands} commands. In Claude Code run /reload-plugins (or start a new session) to pick up changes.`);
    });
  plugin
    .command('install')
    .description('Build the local plugin copy and register it with Claude Code (resync@resync-local)')
    .option('--print', 'only print the commands to run')
    .action(async (o) => {
      const r = await buildLocalPlugin();
      const steps = [
        ['plugin', 'marketplace', 'add', r.root],
        ['plugin', 'install', 'resync@resync-local'],
      ];
      if (o.print) {
        out(steps.map((s) => `claude ${s.map((a) => (a.includes(' ') ? `"${a}"` : a)).join(' ')}`).join('\n'));
        return;
      }
      const claude = await resolveExecutable('claude');
      if (!claude) {
        out('Claude Code was not found on PATH. Run these yourself:\n' + steps.map((s) => `  claude ${s.join(' ')}`).join('\n'));
        return;
      }
      for (const s of steps) {
        const { stdout, stderr } = await exec(claude, s, { windowsHide: true }).catch((e) => ({ stdout: e.stdout ?? '', stderr: e.stderr ?? e.message }));
        out(`$ claude ${s.join(' ')}\n${String(stdout).trim()}${stderr ? `\n${String(stderr).trim()}` : ''}`);
      }
      out('Done. Start a new Claude Code session (or /reload-plugins) and try /resync:prompts.');
    });

  // ---- Team server (optional) ----
  const needServer = (cfg) => {
    if (!cfg.serverUrl) throw new Error('No team server set: ReSync is local-only. Set one with `resync config set serverUrl https://your-resync-server`.');
  };
  program
    .command('login')
    .description('Sign in to your team server (approve a code in the dashboard)')
    .action(async () => {
      const cfg = await loadConfig();
      needServer(cfg);
      await login(cfg, { out, fetch: io.fetch, sleep: io.sleep });
    });
  program
    .command('logout')
    .description('Sign out on this computer (revokes the token)')
    .action(async () => logout(await loadConfig(), { out, fetch: io.fetch }));
  program
    .command('sync')
    .description('Pull team prompts (regenerates /resync: commands) and upload usage numbers and opted-in queue reports')
    .action(async () => {
      const cfg = await loadConfig();
      needServer(cfg);
      await sync(cfg, { out, fetch: io.fetch, skipPlugin: io.skipPlugin });
    });
  program
    .command('share <file>')
    .description('Share a passport, summary or tree file with your team (explicit, per item)')
    .option('--kind <kind>', 'passport | summary | tree (default: from the folder name)')
    .option('--title <title>')
    .action(async (file, o) => {
      const cfg = await loadConfig();
      needServer(cfg);
      const content = await fs.readFile(file, 'utf8');
      const kind = o.kind ?? (/passports/.test(file) ? 'passport' : /trees/.test(file) ? 'tree' : 'summary');
      const title = o.title ?? (/^# .*?:\s*(.+)$/m.exec(content)?.[1] ?? path.basename(file, path.extname(file)));
      const client = await syncClient(cfg, { fetch: io.fetch });
      await client.share({ kind, title: title.slice(0, 200), content, project: path.basename(process.cwd()) });
      out(`Shared "${title}" with your team (${kind}). It now appears on the dashboard under Shared passports.`);
    });

  const statusline = program.command('statusline').description("Claude Code statusline: model, context, session cost, today's total (estimates)");
  statusline
    .command('install')
    .description('Add the ReSync statusline to ~/.claude/settings.json (a backup is kept)')
    .option('--force', 'replace an existing statusLine that is not ReSync')
    .action(async (o) => {
      const r = await installStatusline({ force: o.force });
      out(`Statusline set in ${r.settings}\n  command: ${r.command}${r.backup ? `\n  backup: ${r.backup}` : ''}${r.replaced ? `\n  replaced: ${JSON.stringify(r.replaced)}` : ''}\nIt appears on the next Claude Code update of the status line (send a message or restart).`);
    });
  statusline
    .command('uninstall')
    .description('Remove the ReSync statusline from settings.json')
    .action(async () => {
      const r = await uninstallStatusline();
      out(r.removed ? `Removed the ReSync statusline from ${r.settings} (backup kept).` : `No ReSync statusline found in ${r.settings}.`);
    });
}
