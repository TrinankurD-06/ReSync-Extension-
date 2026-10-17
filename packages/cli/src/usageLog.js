// ~/.resync/usage.jsonl: one usage record (numbers only) per line.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { validateUsageRecord } from '@resync/shared/usage';
import { paths } from './config.js';

/**
 * Validate and append a record.
 * @param {unknown} record
 */
export async function appendUsage(record) {
  const v = validateUsageRecord(record);
  if (!v.ok) throw new Error(`Invalid usage record: ${v.errors.join('; ')}`);
  await fs.mkdir(path.dirname(paths.usage()), { recursive: true });
  await fs.appendFile(paths.usage(), JSON.stringify(v.record) + '\n', 'utf8');
  return v.record;
}

/**
 * Read all valid records; malformed lines are skipped (and counted).
 * @returns {Promise<{ records: import('@resync/shared/usage').UsageRecord[], skipped: number }>}
 */
export async function readUsage() {
  let text;
  try {
    text = await fs.readFile(paths.usage(), 'utf8');
  } catch (e) {
    if (/** @type {any} */ (e).code === 'ENOENT') return { records: [], skipped: 0 };
    throw e;
  }
  const records = [];
  let skipped = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const v = validateUsageRecord(JSON.parse(line));
      if (v.ok) records.push(v.record);
      else skipped++;
    } catch {
      skipped++;
    }
  }
  return { records, skipped };
}
