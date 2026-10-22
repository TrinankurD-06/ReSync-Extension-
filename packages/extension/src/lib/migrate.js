// One-time move of data saved before the rename to ReSync (keys "relay.*") to the current keys ("resync.*").
// Runs on install and update, so an existing user keeps their settings, prompts, colours, vault and ledger.

const OLD_PREFIX = 'relay.';
const NEW_PREFIX = 'resync.';

/**
 * Copies every "relay.*" key to its "resync.*" name (never overwriting a value that already exists there), then removes
 * the old keys.
 * @param {{ get(k: null): Promise<Record<string, any>>, set(o: Record<string, any>): Promise<void>, remove(k: string[]): Promise<void> }} [area]
 * @returns {Promise<number>} how many keys were moved
 */
export async function migrateRenamedKeys(area) {
  const store = area ?? chrome.storage.local;
  const all = await store.get(null);
  const old = Object.keys(all).filter((k) => k.startsWith(OLD_PREFIX));
  if (!old.length) return 0;
  /** @type {Record<string, any>} */
  const moved = {};
  for (const k of old) {
    const next = NEW_PREFIX + k.slice(OLD_PREFIX.length);
    if (!(next in all)) moved[next] = all[k];
  }
  if (Object.keys(moved).length) await store.set(moved);
  await store.remove(old);
  return Object.keys(moved).length;
}
