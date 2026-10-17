// Entry point for the `resync` CLI.
import { buildProgram } from './cli.js';
import { extendProgram } from './commands.js';
import { loadConfig } from './config.js';
import { syncClient } from './sync.js';

/** Upload a finished queue report summary right away when the user opted in and is signed in. */
async function uploadReport(report) {
  const cfg = await loadConfig();
  if (!cfg.serverUrl || !cfg.queue.uploadReports) return;
  const client = await syncClient(cfg);
  if (client.signedIn) await client.uploadQueueReport(report);
}

/** @param {string[]} argv */
export async function main(argv) {
  const program = buildProgram({ extend: (p) => extendProgram(p), onReport: uploadReport });
  await program.parseAsync(argv);
}
