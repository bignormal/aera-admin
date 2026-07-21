import { defineConfig } from '@playwright/test';

const baseURL = process.env.AERA_ADMIN_E2E_BASE_URL ?? 'http://localhost:18080';

export default defineConfig({
  expect: { timeout: 10_000 },
  forbidOnly: Boolean(process.env.CI),
  fullyParallel: false,
  globalSetup: './e2e/global-setup.ts',
  globalTeardown: './e2e/global-teardown.ts',
  outputDir: process.env.AERA_ADMIN_E2E_ARTIFACT_DIR ?? 'tmp/e2e/test-results',
  reporter: [['list']],
  retries: 0,
  testDir: './e2e',
  timeout: 45_000,
  use: {
    baseURL,
    browserName: 'chromium',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    video: 'off',
  },
  workers: 1,
});
