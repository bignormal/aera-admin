import { defineConfig, devices } from '@playwright/test';
import { mkdirSync } from 'node:fs';

mkdirSync('.tmp', { recursive: true });
process.env.DATABASE_URL ||= `file:./.tmp/soybean-e2e-${process.pid}.db`;
process.env.PAYLOAD_SECRET ||= 'agentera-soybean-e2e-secret';
process.env.NEXT_PUBLIC_SERVER_URL ||= 'http://127.0.0.1:3101';
process.env.ADMIN_WEB_URL ||= 'http://127.0.0.1:9527';

export default defineConfig({
  testDir: './tests/e2e-soybean',
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:9527',
    trace: 'on-first-retry'
  },
  projects: [
    {
      name: 'chrome',
      use: { ...devices['Desktop Chrome'], channel: 'chrome' }
    }
  ],
  webServer: [
    {
      command: 'cross-env NEXT_DIST_DIR=.next-soybean-e2e pnpm dev --port 3101',
      url: 'http://127.0.0.1:3101/api/admins/me',
      reuseExistingServer: false,
      timeout: 120_000
    },
    {
      command:
        'cross-env VITE_PAYLOAD_PROXY_TARGET=http://127.0.0.1:3101 pnpm --dir admin-web dev --host 127.0.0.1 --port 9527',
      url: 'http://127.0.0.1:9527/admin/login',
      reuseExistingServer: false,
      timeout: 120_000
    }
  ]
});
