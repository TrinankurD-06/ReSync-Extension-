// Build 1 of 2: side panel page + background service worker (ES module; MV3 allows "type": "module").
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync, writeFileSync } from 'node:fs';
import { resyncSeeds } from './seedsPlugin.js';

/**
 * Test-only build (`vite build --mode e2e`): pre-grant http://127.0.0.1/* and http://localhost/* so the end-to-end test can reach a
 * mock provider without Chrome's permission prompt (which automation cannot click). Never used for releases.
 */
function e2eManifest() {
  let mode = 'production';
  return {
    name: 'resync-e2e-manifest',
    configResolved(c) {
      mode = c.mode;
    },
    closeBundle() {
      if (mode !== 'e2e') return;
      const file = 'dist-e2e/manifest.json';
      const m = JSON.parse(readFileSync(file, 'utf8'));
      // Both spellings: ReSync requests both for local servers (Chrome treats them as different origins).
      m.host_permissions = [...m.host_permissions, 'http://127.0.0.1/*', 'http://localhost/*'];
      m.name = `${m.name} (e2e test build)`;
      writeFileSync(file, JSON.stringify(m, null, 2));
    },
  };
}

export default defineConfig(({ mode }) => ({
  plugins: [react(), e2eManifest(), resyncSeeds()],
  base: './',
  build: {
    // The test build goes to its own folder so dist/ is always the real extension.
    outDir: mode === 'e2e' ? 'dist-e2e' : 'dist',
    emptyOutDir: true,
    target: 'chrome116',
    rolldownOptions: {
      input: { sidepanel: 'sidepanel.html', background: 'src/background/index.js' },
      output: {
        // The manifest points at a fixed file name for the service worker.
        entryFileNames: (chunk) => (chunk.name === 'background' ? 'background.js' : 'assets/[name]-[hash].js'),
      },
    },
  },
}));
