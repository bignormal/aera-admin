import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

import type { FullConfig } from '@playwright/test';

import { readCloudFixture, readFixtures, type SensitiveCanary } from './support';

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
  const cloudFixture = readCloudFixture(requiredEnvironment('AERA_ADMIN_E2E_CLOUD_FIXTURE_FILE'));
  const sensitiveCanaries = [...fixtures.sensitiveCanaries];
  if (!sensitiveCanaries.some((canary) => canary.value === cloudFixture.raw_lookup_identity)) {
    sensitiveCanaries.push({ kind: 'cloud_raw_lookup_identity', value: cloudFixture.raw_lookup_identity });
  }
  const serverLog = readFileSync(requiredEnvironment('AERA_ADMIN_E2E_SERVER_LOG'), 'utf8');
  assertNoCanaries(serverLog, sensitiveCanaries, 'structured server log');
  const cloudLog = readFileSync(requiredEnvironment('AERA_ADMIN_E2E_CLOUD_LOG'), 'utf8');
  assertNoCanaries(cloudLog, sensitiveCanaries, 'Cloud contract process log');

  execFileSync(
    requiredEnvironment('AERA_ADMIN_E2E_CLOUD_VERIFY_BINARY'),
    ['verify', '--fixture', requiredEnvironment('AERA_ADMIN_E2E_CLOUD_FIXTURE_FILE')],
    { env: process.env, stdio: 'inherit' },
  );

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
