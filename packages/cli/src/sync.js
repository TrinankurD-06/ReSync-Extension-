// `resync login`, `resync logout`, `resync sync`: talk to a ReSync team server (optional; local-only without one).
// Sends prompts, usage NUMBERS and (opt-in) queue report summaries. Never API keys, never conversations.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createSyncClient } from '@resync/shared/sync';
import { jsonToLibrary } from '@resync/shared/prompts';
import { writeLibraryToDir } from '@resync/shared/node/library';
import { paths, resyncHome, writeJsonAtomic } from './config.js';
import { readUsage } from './usageLog.js';
import { readQueue } from './queue/store.js';
import { getSecret, setSecret, removeSecret } from './keys.js';
import { buildLocalPlugin } from './plugin/build.js';

/** The server token lives in the OS keychain (same store as API keys), never in config files. */
const TOKEN_ACCOUNT = 'resync-server-token';

/** @param {import('./config.js').ReSyncConfig} cfg @param {{ fetch?: typeof fetch }} [o] */
export async function syncClient(cfg, o = {}) {
  const token = process.env.RESYNC_TOKEN || (await getSecret(TOKEN_ACCOUNT)) || undefined;
  return createSyncClient({ serverUrl: cfg.serverUrl, token, fetch: o.fetch, client: 'cli' });
}

async function readState() {
  try {
    return JSON.parse(await fs.readFile(paths.syncState(), 'utf8'));
  } catch {
    return { uploadedReports: [] };
  }
}

/**
 * Device-code login: print the code and URL, wait for approval in the dashboard, store the token.
 * @param {import('./config.js').ReSyncConfig} cfg
 * @param {{ out: (s: string) => void, fetch?: typeof fetch, sleep?: (ms: number) => Promise<void>, label?: string }} o
 */
export async function login(cfg, o) {
  const client = await syncClient(cfg, o);
  const start = await client.startDeviceLogin(o.label ?? `resync CLI (${process.env.COMPUTERNAME || process.env.HOSTNAME || 'this computer'})`);
  o.out(`To sign in, open ${start.verificationUriComplete ?? start.verificationUri}\nand confirm the code: ${start.userCode}\nWaiting for approval (expires in ${Math.round(start.expiresIn / 60)} min)...`);
  const r = await client.pollDeviceToken(start, { sleep: o.sleep });
  // Stored in the OS keychain like an API key, but kept out of the provider list.
  await setSecret(TOKEN_ACCOUNT, r.token);
  o.out(`Signed in as ${r.user.name}${r.user.teamId ? '' : ' (not in a team yet: create or join one in the dashboard)'}. Revoke this login any time on the dashboard Team page.`);
  return r.user;
}

/** @param {import('./config.js').ReSyncConfig} cfg @param {{ out: (s: string) => void, fetch?: typeof fetch }} o */
export async function logout(cfg, o) {
  const client = await syncClient(cfg, o);
  if (client.signedIn && cfg.serverUrl) await client.logout().catch(() => {});
  await removeSecret(TOKEN_ACCOUNT);
  o.out('Signed out on this computer.');
}

/**
 * Pull team + personal prompts (and regenerate the /resync: commands), upload usage numbers, and upload
 * finished queue report summaries when queue.uploadReports is on.
 * @param {import('./config.js').ReSyncConfig} cfg
 * @param {{ out: (s: string) => void, fetch?: typeof fetch, skipPlugin?: boolean }} o
 */
export async function sync(cfg, o) {
  const client = await syncClient(cfg, o);
  const state = await readState();
  const me = await client.me();
  o.out(`Syncing with ${client.serverUrl} as ${me.name}${me.team ? ` (team ${me.team.name})` : ''}...`);

  // 1) Prompts: the server library replaces the local synced copy.
  const lib = jsonToLibrary(await client.getLibrary());
  const dir = path.join(resyncHome(), 'library');
  await fs.rm(dir, { recursive: true, force: true });
  await writeLibraryToDir(dir, lib.prompts);
  const team = lib.prompts.filter((p) => p.scope === 'team').length;
  o.out(`  prompts: ${lib.prompts.length} (${team} team, ${lib.prompts.length - team} personal)${lib.errors.length ? `, ${lib.errors.length} skipped as invalid` : ''}`);
  if (!o.skipPlugin) {
    const built = await buildLocalPlugin();
    o.out(`  Claude Code commands regenerated (${built.commands}); run /reload-plugins in Claude Code to see them.`);
  }

  // 2) Usage numbers (the last 90 days; the server upserts, so re-sending never double counts).
  const { records } = await readUsage();
  const cutoff = new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10);
  const recent = records.filter((r) => r.date >= cutoff);
  const up = recent.length ? await client.uploadUsage(recent) : { sent: 0, accepted: 0, skipped: 0 };
  o.out(`  usage records uploaded: ${up.accepted} (numbers only)`);

  // 3) Queue report summaries (opt-in).
  let reports = 0;
  if (cfg.queue.uploadReports) {
    const { tasks } = await readQueue();
    for (const t of tasks.filter((x) => (x.status === 'done' || x.status === 'failed') && !state.uploadedReports.includes(x.id))) {
      await client.uploadQueueReport(await reportSummary(t));
      state.uploadedReports.push(t.id);
      reports++;
    }
    o.out(`  queue reports uploaded: ${reports}`);
  }

  await writeJsonAtomic(paths.syncState(), { ...state, lastSyncAt: new Date().toISOString() });
  return { prompts: lib.prompts.length, usage: up.accepted, reports };
}

/** Summary fields for one finished task (the report text is trimmed to the "What was done" part). */
export async function reportSummary(t) {
  let text = '';
  if (t.reportFile) text = await fs.readFile(t.reportFile, 'utf8').catch(() => '');
  const done = /## What was done\n\n([\s\S]*?)\n## /.exec(text)?.[1]?.trim() ?? t.lastError ?? '';
  const files = /## Files changed\n\n([\s\S]*?)\n## /.exec(text)?.[1]?.split('\n').map((l) => l.replace(/^- `|`$/g, '')).filter((l) => l && l !== 'None.') ?? [];
  const tests = /## Tests run\n\n([\s\S]*?)\n/.exec(text)?.[1]?.trim();
  return {
    taskId: t.id, title: t.task.slice(0, 200), status: t.status, summary: done.slice(0, 4000), branch: t.branch,
    filesChanged: files.slice(0, 500), ...(tests && tests !== 'Not reported.' ? { testsRun: tests.slice(0, 500) } : {}),
    startedAt: t.createdAt, finishedAt: t.updatedAt,
  };
}
