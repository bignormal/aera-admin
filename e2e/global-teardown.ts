import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

import type { FullConfig } from '@playwright/test';

import { readFixtures, type SensitiveCanary } from './support';

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function assertNoCanaries(source: string, canaries: SensitiveCanary[], sourceName: string): void {
  for (const [index, canary] of canaries.entries()) {
    if (canary.value !== '' && source.includes(canary.value)) {
      throw new Error(`${sourceName} contains sensitive canary ${index} (${canary.kind})`);
    }
  }
}

export default function globalTeardown(_config: FullConfig): void {
  const fixtureFile = requiredEnvironment('AERA_ADMIN_E2E_FIXTURE_FILE');
  if (!existsSync(fixtureFile)) return;
  const fixtures = readFixtures();
  const serverLog = readFileSync(requiredEnvironment('AERA_ADMIN_E2E_SERVER_LOG'), 'utf8');
  assertNoCanaries(serverLog, fixtures.sensitiveCanaries, 'structured server log');

  execFileSync(
    'go',
    ['test', './internal/audit', '-run', '^TestE2EAcceptance$', '-count=1', '-v'],
    {
      cwd: requiredEnvironment('AERA_ADMIN_E2E_REPO_ROOT'),
      env: process.env,
      stdio: 'inherit',
    },
  );
}
