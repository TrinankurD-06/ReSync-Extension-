// Passports, trees and summaries made in the extension. Kept locally (last 50); they reach the team server
// only when the user clicks Share (per item, opt-in).
export const ARTIFACTS_KEY = 'resync.artifacts';
const MAX = 50;

/**
 * @typedef {{ id: string, kind: 'passport' | 'tree' | 'summary', title: string, content: string, data?: unknown, mode: 'in-chat' | 'api', createdAt: number, sharedAt?: number }} Artifact
 * @param {{ get(k: string): Promise<Record<string, any>>, set(o: Record<string, any>): Promise<void> }} [area]
 */
export function createArtifacts(area) {
  const store = area ?? chrome.storage.local;
  const read = async () => /** @type {Artifact[]} */ ((await store.get(ARTIFACTS_KEY))[ARTIFACTS_KEY] ?? []);
  return {
    list: read,
    /** @param {Omit<Artifact, 'id' | 'createdAt'>} a */
    async add(a) {
      const item = { ...a, id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, createdAt: Date.now() };
      await store.set({ [ARTIFACTS_KEY]: [item, ...(await read())].slice(0, MAX) });
      return item;
    },
    /** @param {string} id @param {Partial<Artifact>} patch */
    async update(id, patch) {
      await store.set({ [ARTIFACTS_KEY]: (await read()).map((x) => (x.id === id ? { ...x, ...patch } : x)) });
    },
    /** @param {string} id */
    async remove(id) {
      await store.set({ [ARTIFACTS_KEY]: (await read()).filter((x) => x.id !== id) });
    },
  };
}
