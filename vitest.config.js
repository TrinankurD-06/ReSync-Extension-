import { defineConfig } from 'vitest/config';

// Each package is its own Vitest project; packages may add their own vitest.config.js.
export default defineConfig({
  test: {
    projects: ['packages/*'],
  },
});
