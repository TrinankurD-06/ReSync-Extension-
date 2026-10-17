// The extension's prompt library (chrome.storage.local). Seeded from the repo's prompts/ folder at build time.
// Team prompts and personal edits sync to the server when signed in (Phase 8).
import { validatePrompt } from '@resync/shared/prompts';
import SEEDS from 'virtual:resync-seeds'; // parsed at build time by seedsPlugin.js (no YAML parser in the bundle)

export const LIBRARY_KEY = 'resync.library';
/** Edits and deletes waiting to be pushed to the team server, and ids that came from it (see syncEngine.js). */
export const DIRTY_KEY = 'resync.dirtyPrompts';
export const DELETED_KEY = 'resync.deletedPrompts';
export const SYNCED_KEY = 'resync.syncedPromptIds';

/** Seed prompts from /prompts/<category>/<slug>.md, parsed and validated at build time. */
export function seedPrompts() {
  return structuredClone(SEEDS);
}

/** @param {import('@resync/shared/prompts').Prompt} p */
export const promptId = (p) => `${p.scope}/${p.category}/${p.slug}`;

/**
 * Case-insensitive search over title, description, tags, category and body, with filters.
 * @param {import('@resync/shared/prompts').Prompt[]} prompts
 * @param {{ text?: string, scope?: 'all' | 'personal' | 'team', category?: string, tag?: string }} [q]
 */
export function searchPrompts(prompts, q = {}) {
  const words = (q.text ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  return prompts
    .filter((p) => !q.scope || q.scope === 'all' || p.scope === q.scope)
    .filter((p) => !q.category || p.category === q.category)
    .filter((p) => !q.tag || p.tags.includes(q.tag))
    .map((p) => {
      const title = p.title.toLowerCase();
      const hay = [title, p.description, p.category, p.slug, ...p.tags, p.body, ...p.steps.map((s) => s.text)].join(' ').toLowerCase();
      if (!words.every((w) => hay.includes(w))) return null;
      const score = words.reduce((s, w) => s + (title.includes(w) ? 3 : 0) + (p.tags.some((t) => t.toLowerCase().includes(w)) ? 2 : 0), 0);
      return { p, score };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score || a.p.title.localeCompare(b.p.title))
    .map((x) => x.p);
}

/** Categories and tags present in a library (for filter dropdowns). @param {import('@resync/shared/prompts').Prompt[]} prompts */
export function facets(prompts) {
  return {
    categories: [...new Set(prompts.map((p) => p.category))].sort(),
    tags: [...new Set(prompts.flatMap((p) => p.tags))].sort(),
  };
}

/**
 * @param {{ get(k: string): Promise<Record<string, any>>, set(o: Record<string, any>): Promise<void> }} [area]
 * @param {{ seeds?: () => import('@resync/shared/prompts').Prompt[] }} [o]
 */
export function createLibrary(area, o = {}) {
  const store = area ?? chrome.storage.local;
  const seeds = o.seeds ?? seedPrompts;

  /** Record a deletion to push, only for prompts that exist on the server (were synced). */
  async function queueDelete(id) {
    const synced = new Set((await store.get(SYNCED_KEY))[SYNCED_KEY] ?? []);
    const dirty = ((await store.get(DIRTY_KEY))[DIRTY_KEY] ?? []).filter((x) => x !== id);
    if (!synced.has(id)) return { [DIRTY_KEY]: dirty };
    const [scope, category, slug] = id.split('/');
    const deleted = (await store.get(DELETED_KEY))[DELETED_KEY] ?? [];
    return { [DELETED_KEY]: [...deleted, { scope, category, slug }], [DIRTY_KEY]: dirty };
  }

  async function read() {
    const data = (await store.get(LIBRARY_KEY))[LIBRARY_KEY];
    if (data && Array.isArray(data.prompts)) return data;
    const fresh = { prompts: seeds(), updatedAt: Date.now() };
    await store.set({ [LIBRARY_KEY]: fresh });
    return fresh;
  }

  return {
    /** @returns {Promise<import('@resync/shared/prompts').Prompt[]>} */
    async list() {
      return (await read()).prompts;
    },
    /**
     * Add or replace a prompt (matched by scope/category/slug). Validates first.
     * @param {unknown} prompt
     * @param {string} [previousId] when renaming/moving, the old id to remove
     */
    async upsert(prompt, previousId) {
      const r = validatePrompt(prompt);
      if (!r.ok) throw new Error(r.errors.join('; '));
      const data = await read();
      const id = promptId(r.prompt);
      data.prompts = data.prompts.filter((p) => promptId(p) !== id && promptId(p) !== previousId);
      data.prompts.push(r.prompt);
      data.updatedAt = Date.now();
      // Queue the edit for the team server; a move/rename also deletes the old copy there.
      const extra = previousId && previousId !== id ? await queueDelete(previousId) : {};
      const dirty = new Set(extra[DIRTY_KEY] ?? (await store.get(DIRTY_KEY))[DIRTY_KEY] ?? []);
      dirty.add(id);
      await store.set({ [LIBRARY_KEY]: data, ...extra, [DIRTY_KEY]: [...dirty] });
      return r.prompt;
    },
    /** @param {string} id */
    async remove(id) {
      const data = await read();
      data.prompts = data.prompts.filter((p) => promptId(p) !== id);
      data.updatedAt = Date.now();
      await store.set({ [LIBRARY_KEY]: data, ...(await queueDelete(id)) });
    },
    /** Replace all prompts of one scope (used when pulling the team library from the server). */
    async replaceScope(scope, prompts) {
      const data = await read();
      data.prompts = [...data.prompts.filter((p) => p.scope !== scope), ...prompts.filter((p) => p.scope === scope)];
      data.updatedAt = Date.now();
      await store.set({ [LIBRARY_KEY]: data });
    },
  };
}
