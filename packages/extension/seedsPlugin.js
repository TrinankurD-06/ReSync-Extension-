// Vite plugin: parse the repo's seed prompts (prompts/<category>/<slug>.md) at BUILD time and expose them as
// `virtual:resync-seeds` (plain JSON). The extension then ships no YAML parser.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLibraryFromDir } from '@resync/shared/node/library';

const ID = 'virtual:resync-seeds';
const PROMPTS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../prompts');

export function resyncSeeds() {
  return {
    name: 'resync-seeds',
    resolveId(id) {
      return id === ID ? `\0${ID}` : null;
    },
    async load(id) {
      if (id !== `\0${ID}`) return null;
      const { prompts, errors } = await loadLibraryFromDir(PROMPTS);
      if (errors.length) this.warn(`invalid seed prompts skipped: ${errors.map((e) => e.file).join(', ')}`);
      return `export default ${JSON.stringify(prompts)};`;
    },
  };
}
