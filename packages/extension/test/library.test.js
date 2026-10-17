import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLibrary, searchPrompts, facets, promptId } from '../src/lib/library.js';
import { loadLibraryFromDir } from '@resync/shared/node/library';
import { memoryArea } from './fakeChrome.js';

const SEEDS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../prompts');
const seeds = (await loadLibraryFromDir(SEEDS_DIR)).prompts;

describe('extension prompt library', () => {
  it('seeds from the bundled prompts on first use (via import.meta.glob)', async () => {
    const lib = createLibrary(memoryArea());
    const list = await lib.list();
    expect(list).toHaveLength(8);
    expect(list.map(promptId).sort()).toEqual(seeds.map(promptId).sort());
    expect((await fs.readdir(SEEDS_DIR)).sort()).toEqual(['dev', 'startup', 'study']);
  });

  it('searches by words across title, tags and body, ranking title matches first', () => {
    const r = searchPrompts(seeds, { text: 'review' });
    expect(r[0].slug).toBe('code-review');
    expect(searchPrompts(seeds, { text: 'chain launch' }).map((p) => p.slug)).toEqual(['launch-chain']);
    expect(searchPrompts(seeds, { scope: 'personal' }).every((p) => p.scope === 'personal')).toBe(true);
    expect(searchPrompts(seeds, { category: 'study' })).toHaveLength(2);
    expect(searchPrompts(seeds, { tag: 'chain' })).toHaveLength(2);
    expect(searchPrompts(seeds, { text: 'zzzz' })).toEqual([]);
  });

  it('lists categories and tags for filters', () => {
    const f = facets(seeds);
    expect(f.categories).toEqual(['dev', 'startup', 'study']);
    expect(f.tags).toContain('chain');
  });

  it('upserts with validation, moves between scopes, removes, and replaces a scope', async () => {
    const lib = createLibrary(memoryArea(), { seeds: () => seeds });
    const p = seeds.find((x) => x.slug === 'flashcards');
    await expect(lib.upsert({ ...p, body: 'uses {{nope}}' })).rejects.toThrow(/not declared/);
    const moved = await lib.upsert({ ...p, scope: 'team' }, promptId(p));
    expect((await lib.list()).filter((x) => x.slug === 'flashcards').map((x) => x.scope)).toEqual(['team']);
    await lib.remove(promptId(moved));
    expect((await lib.list()).some((x) => x.slug === 'flashcards')).toBe(false);
    await lib.replaceScope('team', [{ ...p, scope: 'team', slug: 'new-team' }]);
    const list = await lib.list();
    expect(list.filter((x) => x.scope === 'team').map((x) => x.slug)).toEqual(['new-team']);
    expect(list.some((x) => x.scope === 'personal')).toBe(true);
  });
});
