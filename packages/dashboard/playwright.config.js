import { defineConfig } from '@playwright/test';

// Dashboard smoke tests against the real server + an in-memory MongoDB (e2e/serve.mjs). Run `vite build` first
// (the test:e2e script does). One worker to keep memory use low.
export default defineConfig({
  testDir: 'e2e',
  timeout: 90_000,
  workers: 1,
  reporter: [['list']],
  use: { baseURL: 'http://127.0.0.1:4319', trace: 'retain-on-failure' },
  webServer: {
    command: 'node e2e/serve.mjs',
    url: 'http://127.0.0.1:4319/api/v1/health',
    timeout: 120_000,
    reuseExistingServer: false,
  },
});
