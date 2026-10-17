import { defineConfig } from 'vitest/config';
import { resyncSeeds } from './seedsPlugin.js';

// Extension logic is tested in a simulated DOM (happy-dom); chrome.* APIs are faked per test.
export default defineConfig({
  plugins: [resyncSeeds()],
  test: {
    name: '@resync/extension',
    environment: 'happy-dom',
    include: ['test/**/*.test.{js,jsx}'],
  },
});
