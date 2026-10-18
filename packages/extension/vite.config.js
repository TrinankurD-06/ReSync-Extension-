// Build 1 of 2: side panel page + background service worker (ES module; MV3 allows "type": "module").
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { createRequire } from 'node:module';
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

/**
 * Copy Mermaid's prebuilt browser bundle into the extension (vendor/mermaid.min.js). Extension pages may only run
 * scripts packaged with the extension (MV3 CSP), so it can't come from a CDN. The side panel loads it only when a
 * mindmap is shown, so it costs nothing until then.
 */
function vendorMermaid() {
  let outDir = 'dist';
  return {
    name: 'resync-vendor-mermaid',
    configResolved(c) {
      outDir = c.build.outDir;
    },
    closeBundle() {
      const file = createRequire(import.meta.url).resolve('mermaid/dist/mermaid.min.js');
      mkdirSync(`${outDir}/vendor`, { recursive: true });
      copyFileSync(file, `${outDir}/vendor/mermaid.min.js`);
    },
  };
}

export default defineConfig(({ mode }) => ({
  plugins: [react(), e2eManifest(), resyncSeeds(), vendorMermaid()],
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
