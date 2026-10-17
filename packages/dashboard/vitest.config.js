import { defineConfig } from 'vitest/config';

// The dashboard is covered by Playwright (e2e/*.spec.js, run with `npm run test:e2e`), not Vitest.
export default defineConfig({
  test: {
    name: '@resync/dashboard',
    include: ['test/**/*.test.{js,jsx}'],
    passWithNoTests: true,
  },
});
