import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './tests/e2e-live',
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: process.env.AGENTERA_ADMIN_LIVE_URL || 'http://127.0.0.1:9527',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chrome', use: { ...devices['Desktop Chrome'], channel: 'chrome' } }],
})
