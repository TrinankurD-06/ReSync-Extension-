// Node resolve hook for full-sync.spec.js: the extension's library.js imports `virtual:resync-seeds`, which only
// Vite resolves (extension/seedsPlugin.js). The test passes its own seeds, so plain Node gets an empty list.
// Synchronous registerHooks, to chain with Playwright's own loader (an async register() clashes with it).
import { registerHooks } from 'node:module';

const EMPTY_SEEDS = new URL('./emptySeeds.js', import.meta.url).href;

registerHooks({
  resolve: (specifier, context, next) => (specifier === 'virtual:resync-seeds' ? { url: EMPTY_SEEDS, format: 'module', shortCircuit: true } : next(specifier, context)),
});
