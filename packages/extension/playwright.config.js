import { defineConfig } from '@playwright/test';

// End-to-end smoke test of the built extension in Playwright's Chromium (branded Chrome no longer loads
// unpacked extensions from the command line). One worker: the machine is RAM-constrained.
export default defineConfig({
  testDir: 'e2e',
  timeout: 240_000,
  workers: 1,
  reporter: [['list']],
  use: { trace: 'retain-on-failure' },
});
