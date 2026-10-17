// Build 2 of 2: the content script as ONE classic (IIFE) file; content scripts cannot import chunks.
import { defineConfig } from 'vite';
import { resyncSeeds } from './seedsPlugin.js';

export default defineConfig(({ mode }) => ({
  plugins: [resyncSeeds()],
  publicDir: false,
  build: {
    outDir: mode === 'e2e' ? 'dist-e2e' : 'dist',
    emptyOutDir: false,
    target: 'chrome116',
    lib: { entry: 'src/content/index.js', formats: ['iife'], name: 'ReSyncContent', fileName: () => 'content.js' },
  },
}));
