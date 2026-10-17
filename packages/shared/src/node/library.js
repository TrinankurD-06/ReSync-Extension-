// Node-only helpers for reading and writing a prompt library on disk.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parsePrompt, validatePrompt, serializePrompt } from '../prompts.js';

/**
 * Load every <dir>/<category>/<slug>.md.
 * @param {string} dir
 * @returns {Promise<{ prompts: import('../prompts.js').Prompt[], errors: { file: string, errors: string[] }[] }>}
 */
export async function loadLibraryFromDir(dir) {
  const prompts = [];
  const errors = [];
  let categories;
  try {
    categories = await fs.readdir(dir, { withFileTypes: true });
  } catch (e) {
    if (/** @type {any} */ (e).code === 'ENOENT') return { prompts, errors };
    throw e;
  }
  for (const c of categories) {
    if (!c.isDirectory()) continue;
    const files = await fs.readdir(path.join(dir, c.name));
    for (const f of files.filter((f) => f.endsWith('.md')).sort()) {
      const file = path.join(dir, c.name, f);
      const text = await fs.readFile(file, 'utf8');
      const r = validatePrompt(parsePrompt(text, { path: `${c.name}/${f}` }));
      if (r.ok) prompts.push(r.prompt);
      else errors.push({ file, errors: r.errors });
    }
  }
  return { prompts, errors };
}

/**
 * Write prompts to <dir>/<category>/<slug>.md.
 * @param {string} dir
 * @param {import('../prompts.js').Prompt[]} prompts
 */
export async function writeLibraryToDir(dir, prompts) {
  for (const p of prompts) {
    await fs.mkdir(path.join(dir, p.category), { recursive: true });
    await fs.writeFile(path.join(dir, p.category, `${p.slug}.md`), serializePrompt(p), 'utf8');
  }
}
