// The `resync` command. Built as a function so tests can run it without spawning a process.
import { Command, Option } from 'commander';
import path from 'node:path';
import { testConnection, listAdapters } from '@resync/shared/providers';
import { FEATURES, PROVIDER_TYPES, ApiModeOffError } from '@resync/shared/models';
import { loadConfig, saveConfig, getPath, setPath, paths, resyncHome } from './config.js';
import { setKey, removeKey, listKeys, providerConfig } from './keys.js';
import { addTask, readQueue, removeTask } from './queue/store.js';
import { repoRoot } from './queue/worktree.js';
import { runQueue, msUntil, sleepMs } from './queue/run.js';
import { getRunner, listRunners } from './queue/runners/index.js';
import { readUsage } from './usageLog.js';
import { usageReport, table } from './usageTables.js';
import { runApiFeature } from './aiFeatures.js';
import { readSecret } from './util/prompt.js';

/**
 * @param {{ out?: (s: string) => void, err?: (s: string) => void, write?: (s: string) => void, cwd?: string, fetch?: typeof fetch, extend?: (program: Command) => void }} [io]
 */
export function buildProgram(io = {}) {
  const out = io.out ?? ((s) => console.log(s));
  const err = io.err ?? ((s) => console.error(s));
  const write = io.write ?? ((s) => process.stdout.write(s));
  const cwd = () => io.cwd ?? process.cwd();

  const program = new Command('resync')
    .description('ReSync: saved prompts, Context Passport, usage tracking and a limit-aware work queue.\nWorks with no API keys; API mode is optional.')
    .version('0.1.0')
    .showHelpAfterError();
  program.configureOutput({ writeOut: (s) => out(s.trimEnd()), writeErr: (s) => err(s.trimEnd()) });

  // ---------------- keys ----------------
  const keys = program.command('keys').description('API keys for API mode (stored in the OS keychain; never synced)');
  keys
    .command('set <provider>')
    .description('Store a key for a provider (anthropic, openai, gemini, openrouter, or a provider id you added)')
    .option('--stdin', 'read the key from stdin instead of prompting')
    .action(async (provider, o) => {
      const key = await readSecret(`API key for ${provider}: `, { stdin: o.stdin });
      await setKey(provider, key);
      // Convenience: setting a key for a known provider type also adds that provider to the config.
      const fresh = await loadConfig();
      if (!fresh.ai.providers[provider] && /** @type {readonly string[]} */ (PROVIDER_TYPES).includes(provider)) {
        const adapter = listAdapters().find((a) => a.type === provider);
        fresh.ai.providers[provider] = { type: /** @type {any} */ (provider), ...(adapter?.suggestedModels.cheap ? { defaultModel: adapter.suggestedModels.cheap } : {}) };
        await saveConfig(fresh);
        out(`Added provider "${provider}" (default model ${adapter?.suggestedModels.cheap ?? 'not set'}).`);
      }
      out(`Stored the key for ${provider} in the OS keychain. It never leaves this device except to call ${provider}.`);
    });
  keys
    .command('list')
    .description('Show which providers have a key (never shows key values)')
    .action(async () => {
      const list = await listKeys();
      if (!list.length) {
        out('No API keys set. That is fine: ReSync works without keys (in-chat mode). Add one with `resync keys set <provider>` to use API mode.');
        return;
      }
      out(table(['Provider', 'Key source'], list.map((k) => [k.provider, k.source])));
    });
  keys
    .command('test [provider]')
    .description('Check each configured provider can be reached and its key works')
    .option('--model <model>', 'test with a tiny completion on this model instead of listing models')
    .action(async (provider, o) => {
      const cfg = await loadConfig();
      const ids = provider ? [provider] : Object.keys(cfg.ai.providers);
      if (!ids.length) {
        out('No providers configured, so there is nothing to test. ReSync works without keys (in-chat mode).');
        return;
      }
      let failed = 0;
      for (const id of ids) {
        const p = await providerConfig(cfg, id);
        const r = await testConnection(p, { model: o.model, fetch: io.fetch });
        if (r.ok) out(`OK    ${id}: ${r.detail} (${r.latencyMs} ms)`);
        else {
          failed++;
          out(`FAIL  ${id}: [${r.error.kind}] ${r.error.message}\n      ${r.error.hint}`);
        }
      }
      if (failed) process.exitCode = 1;
    });
  keys
    .command('remove <provider>')
    .description('Delete a stored key')
    .action(async (provider) => {
      const removed = await removeKey(provider);
      out(removed ? `Removed the key for ${provider}.` : `No stored key for ${provider} (environment variables are not touched).`);
    });

  // ---------------- providers and feature map ----------------
  const prov = program.command('provider').description('AI providers for API mode (bring your own)');
  prov
    .command('add <id>')
    .description('Add or update a provider, e.g. `resync provider add local --type openai-compatible --base-url http://localhost:11434/v1 --model qwen2.5-coder:7b`')
    .addOption(new Option('--type <type>', 'adapter type').choices([...PROVIDER_TYPES]).makeOptionMandatory())
    .option('--base-url <url>', 'custom base URL (required for openai-compatible unless you use Ollama on localhost)')
    .option('--model <model>', 'default model for this provider')
    .action(async (id, o) => {
      if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new Error('Provider ids use lowercase letters, digits and dashes.');
      const cfg = await loadConfig();
      cfg.ai.providers[id] = { type: o.type, ...(o.baseUrl ? { baseUrl: o.baseUrl } : {}), ...(o.model ? { defaultModel: o.model } : {}) };
      await saveConfig(cfg);
      const needsKey = listAdapters().find((a) => a.type === o.type)?.requiresKey;
      out(`Saved provider "${id}" (${o.type}).${needsKey ? ` Now store its key: resync keys set ${id}` : ''}`);
    });
  prov
    .command('list')
    .description('List configured providers and the feature map')
    .action(async () => {
      const cfg = await loadConfig();
      const ps = Object.entries(cfg.ai.providers);
      out(ps.length ? table(['Id', 'Type', 'Base URL', 'Default model'], ps.map(([id, p]) => [id, p.type, p.baseUrl ?? '(default)', p.defaultModel ?? '-'])) : 'No providers: every feature runs in-chat (no keys needed).');
      out('');
      out(table(['Feature', 'Mode', 'Provider', 'Model'], FEATURES.map((f) => {
        const s = cfg.ai.features[f] ?? { mode: 'in-chat' };
        return [f, s.mode, s.provider ?? '-', s.model ?? '-'];
      })));
    });
  prov
    .command('remove <id>')
    .action(async (id) => {
      const cfg = await loadConfig();
      delete cfg.ai.providers[id];
      for (const f of FEATURES) if (cfg.ai.features[f]?.provider === id) cfg.ai.features[f] = { mode: 'in-chat' };
      await saveConfig(cfg);
      out(`Removed provider "${id}". Features that used it are back to in-chat mode.`);
    });

  program
    .command('feature <feature>')
    .description(`Route a feature (${FEATURES.join(', ')}) to in-chat mode or to a provider/model`)
    .addOption(new Option('--mode <mode>').choices(['in-chat', 'api']).makeOptionMandatory())
    .option('--provider <id>')
    .option('--model <model>')
    .action(async (feature, o) => {
      if (!/** @type {readonly string[]} */ (FEATURES).includes(feature)) throw new Error(`Unknown feature "${feature}". One of: ${FEATURES.join(', ')}`);
      const cfg = await loadConfig();
      if (o.mode === 'api' && o.provider && !cfg.ai.providers[o.provider]) throw new Error(`Provider "${o.provider}" is not configured.`);
      cfg.ai.features[feature] = { mode: o.mode, ...(o.provider ? { provider: o.provider } : {}), ...(o.model ? { model: o.model } : {}) };
      await saveConfig(cfg);
      out(`${feature}: ${o.mode}${o.provider ? ` via ${o.provider}` : ''}${o.model ? ` (${o.model})` : ''}`);
    });

  // ---------------- config ----------------
  const config = program.command('config').description('Read or change ~/.resync/config.json');
  config.command('path').action(() => out(paths.config()));
  config.command('get [key]').action(async (key) => {
    const cfg = await loadConfig();
    out(JSON.stringify(key ? getPath(cfg, key) : cfg, null, 2) ?? 'undefined');
  });
  config.command('set <key> <value>').description('e.g. `resync config set serverUrl https://resync.example.com`').action(async (key, value) => {
    if (/key|secret|token/i.test(key) && !/^keys\.providers$/.test(key)) throw new Error('Secrets do not belong in config. Use `resync keys set` for API keys.');
    const cfg = await loadConfig();
    setPath(cfg, key, value);
    await saveConfig(cfg);
    out(`${key} = ${JSON.stringify(getPath(cfg, key))}`);
  });

  // ---------------- queue ----------------
  const queue = program.command('queue').description('Limit-Aware Work Queue: run tasks headless, one at a time, each in its own worktree and branch');
  queue
    .command('add <task>')
    .description('Queue a task')
    .option('--repo <path>', 'git repository to work in (default: current directory)')
    .option('--prompt <slug>', 'saved prompt to prepend (category-slug or slug)')
    .option('--tools <allowlist>', 'comma-separated tool allowlist (default from config: read, edit, run tests)')
    .option('--runner <name>', 'runner adapter (default claude-code)')
    .option('--skip-permissions', 'DANGEROUS: let this task use any tool without asking (per-task opt-in)')
    .action(async (task, o) => {
      const cfg = await loadConfig();
      const repo = await repoRoot(path.resolve(cwd(), o.repo ?? '.'));
      const tools = o.tools ? splitTools(o.tools) : cfg.queue.defaultTools;
      const runner = o.runner ?? cfg.queue.runner;
      getRunner(runner);
      const t = await addTask({ task, repo, prompt: o.prompt, tools, skipPermissions: Boolean(o.skipPermissions), runner });
      if (o.skipPermissions) {
        err('WARNING: --skip-permissions lets this task run ANY tool (including shell commands) without asking. It still runs in its own worktree and branch, but review its work before merging.');
      }
      out(`Queued ${t.id} in ${repo}\n  tools: ${t.skipPermissions ? 'ALL (skip-permissions)' : t.tools.join(', ')}\nRun it with \`resync queue run\` (or \`resync queue run --at 02:00\`).`);
    });
  queue
    .command('list')
    .option('--all', 'include finished tasks')
    .action(async (o) => {
      const { tasks } = await readQueue();
      const shown = o.all ? tasks : tasks.filter((t) => t.status !== 'done');
      if (!shown.length) {
        out(tasks.length ? 'No open tasks (use --all to see finished ones).' : 'The queue is empty. Add a task: resync queue add "<task>"');
        return;
      }
      out(table(['Id', 'Status', 'Task', 'Repo', 'Next try / note'], shown.map((t) => [
        t.id, t.status, t.task.length > 40 ? t.task.slice(0, 37) + '...' : t.task, path.basename(t.repo),
        t.status === 'waiting-for-reset' && t.notBefore ? new Date(t.notBefore).toLocaleString() : (t.lastError ?? '').slice(0, 40),
      ])));
    });
  queue
    .command('remove <id>')
    .action(async (id) => {
      const t = await removeTask(id);
      out(`Removed ${t.id}. Its branch and worktree (if any) were kept: ${t.branch ?? 'none'}.`);
    });
  queue
    .command('run')
    .description('Run every task that can run now, one at a time')
    .option('--at <time>', 'wait until this local time first, e.g. "02:00"')
    .action(async (o) => {
      const cfg = await loadConfig();
      if (o.at) {
        const ms = msUntil(o.at);
        out(`Waiting until ${new Date(Date.now() + ms).toLocaleString()} to start (keep this terminal open; Ctrl+C to cancel).`);
        await sleepMs(ms);
      }
      await preflight(cfg);
      const s = await runQueue({ config: cfg, out, resolvePrompt: (slug) => resolvePrompt(cfg, slug), onReport: io.onReport });
      out(`Queue finished: ${s.done} done, ${s.failed} failed, ${s.waiting} waiting for a limit reset.`);
    });
  queue
    .command('watch')
    .description('Keep running: retry tasks when limits reset and pick up new tasks (Ctrl+C to stop)')
    .action(async () => {
      const cfg = await loadConfig();
      await preflight(cfg);
      const ac = new AbortController();
      process.once('SIGINT', () => {
        out('\nStopping after the current step...');
        ac.abort();
      });
      out('Watching the queue. Ctrl+C to stop.');
      await runQueue({ config: cfg, out, watch: true, signal: ac.signal, resolvePrompt: (slug) => resolvePrompt(cfg, slug), onReport: io.onReport });
    });
  queue.command('runners').description('List runner adapters').action(() => out(table(['Runner', 'Description'], listRunners().map((r) => [r.name, r.description]))));

  // ---------------- usage ----------------
  program
    .command('usage')
    .description('Per-day and per-project usage tables (estimates)')
    .option('--days <n>', 'how many days', '14')
    .option('--project <name>')
    .option('--json', 'print raw records as JSON')
    .action(async (o) => {
      const { records, skipped } = await readUsage();
      if (o.json) return out(JSON.stringify(records, null, 2));
      out(usageReport(records, { days: Number(o.days), project: o.project }));
      if (skipped) err(`(${skipped} malformed line(s) in ${paths.usage()} were skipped)`);
    });

  // ---------------- passport / tree / summary (API mode) ----------------
  for (const feature of /** @type {const} */ (['passport', 'tree', 'summary'])) {
    program
      .command(feature)
      .description(`Generate a ${feature} from a Claude Code session transcript (API mode). In-chat mode: run /resync:${feature} in Claude Code.`)
      .option('--api', 'use API mode (sends the conversation to your chosen provider)')
      .option('--transcript <file>', 'transcript .jsonl, or a conversation exported with /export')
      .option('--session <id>', 'session id (default: newest session for this folder)')
      .option('--provider <id>')
      .option('--model <model>')
      .action(async (o) => {
        if (!o.api) {
          out(`In-chat mode (the default, no API key needed): run /resync:${feature} inside Claude Code.\nAPI mode: resync ${feature} --api [--provider <id>] [--model <model>]`);
          return;
        }
        const cfg = await loadConfig();
        try {
          await runApiFeature(feature, { config: cfg, cwd: cwd(), transcript: o.transcript && path.resolve(cwd(), o.transcript), sessionId: o.session, provider: o.provider, model: o.model, out, err, write, fetch: io.fetch });
        } catch (e) {
          if (e instanceof ApiModeOffError) {
            err(e.message);
            process.exitCode = 1;
            return;
          }
          throw e;
        }
      });
  }

  program
    .command('where')
    .description('Show where ReSync keeps its files')
    .action(() => out(table(['What', 'Path'], [['ReSync home', resyncHome()], ['Config', paths.config()], ['Queue', paths.queue()], ['Usage log', paths.usage()], ['Task logs', paths.logs()]])));

  io.extend?.(program);
  return program;
}

/** @param {string} s */
export function splitTools(s) {
  // Split on commas that are not inside parentheses, e.g. "Read,Bash(npm test *),Edit".
  const out = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '(') depth++;
    if (ch === ')') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** @param {import('./config.js').ReSyncConfig} cfg */
async function preflight(cfg) {
  const { tasks } = await readQueue();
  const runnerNames = new Set(tasks.filter((t) => t.status === 'pending' || t.status === 'waiting-for-reset').map((t) => t.runner));
  for (const name of runnerNames) {
    const r = getRunner(name);
    if (r.check) {
      const c = await r.check(cfg);
      if (!c.ok) throw new Error(c.detail);
    }
  }
}

/**
 * Text of a saved prompt by slug, from the synced library or the repo's prompts/ folder.
 * @param {import('./config.js').ReSyncConfig} cfg
 * @param {string} slug "category-slug" or "slug"
 */
export async function resolvePrompt(cfg, slug) {
  const { loadLibraryFromDir } = await import('@resync/shared/node/library');
  const { promptText } = await import('@resync/shared/prompts');
  const dirs = [path.join(resyncHome(), 'library'), path.join(process.cwd(), 'prompts')];
  for (const d of dirs) {
    const { prompts } = await loadLibraryFromDir(d);
    const p = prompts.find((x) => x.slug === slug || `${x.category}-${x.slug}` === slug);
    if (p) return promptText(p);
  }
  throw new Error(`Saved prompt "${slug}" not found. Run \`resync sync\` or check the slug with \`resync prompts\`.`);
}
