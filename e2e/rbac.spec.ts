import { expect, test } from '@playwright/test';

import {
  apiRequest,
  appendSensitiveCanaries,
  generateTOTP,
  loginWithRecovery,
  readFixtures,
  type APIResult,
  type SensitiveCanary,
} from './support';

function errorCode(result: APIResult): string | undefined {
  return (result.body as { error?: { code?: string } })?.error?.code;
}

test('every fixed non-super role is denied administrator mutations and only auditors can read the directory', async () => {
  const fixtures = readFixtures();
  const canaries: SensitiveCanary[] = [];
  for (const role of ['developer', 'operator', 'support', 'finance', 'auditor'] as const) {
    const administrator = fixtures.roles[role][0];
    const authenticated = await loginWithRecovery(fixtures.baseURL, administrator, 0, canaries);
    const listed = await apiRequest(fixtures.baseURL, '/admin-users', { cookie: authenticated.cookie });
    if (role === 'auditor') {
      expect(listed.status).toBe(200);
      expect(listed.raw).not.toContain(administrator.email);
    } else {
      expect(listed.status).toBe(403);
      expect(errorCode(listed)).toBe('PERMISSION_DENIED');
    }

    const mutation = await apiRequest(fixtures.baseURL, '/admin-users/invitations', {
      body: {
        display_name: '不应创建',
        email: `denied.${role}@example.test`,
        note: '',
        reason_code: 'staff_change',
        role: 'support',
        ticket_reference: 'E2E-DENIED',
      },
      cookie: authenticated.cookie,
      csrfToken: authenticated.csrfToken,
    });
    expect(mutation.status).toBe(403);
    expect(errorCode(mutation)).toBe('PERMISSION_DENIED');
  }
  appendSensitiveCanaries(canaries);
});

test('Origin, CSRF, step-up replay, and security-version revocation fail closed', async () => {
  const fixtures = readFixtures();
  const canaries: SensitiveCanary[] = [];
  const operator = await loginWithRecovery(fixtures.baseURL, fixtures.roles.operator[0], 1, canaries);
  const superAdministrator = await loginWithRecovery(fixtures.baseURL, fixtures.roles.super_admin[1], 1, canaries);
  const revokePath = `/admin-users/${operator.fixture.adminId}/sessions/revoke`;
  const revokeBody = {
    note: '',
    reason_code: 'suspected_compromise',
    ticket_reference: 'E2E-SESSION-REVOKE',
  };

  const requiresStepUp = await apiRequest(fixtures.baseURL, revokePath, {
    body: revokeBody,
    cookie: superAdministrator.cookie,
    csrfToken: superAdministrator.csrfToken,
  });
  expect(requiresStepUp.status).toBe(403);
  expect(errorCode(requiresStepUp)).toBe('STEP_UP_REQUIRED');

  const stepUpCode = generateTOTP(superAdministrator.fixture.totpSecret, 1);
  const missingOrigin = await apiRequest(fixtures.baseURL, '/auth/step-up', {
    body: { totp_code: stepUpCode },
    cookie: superAdministrator.cookie,
    csrfToken: superAdministrator.csrfToken,
    origin: false,
  });
  expect(missingOrigin.status).toBe(403);
  expect(errorCode(missingOrigin)).toBe('ORIGIN_INVALID');

  const csrfProbe = 'wrong-csrf-e2e-canary';
  const wrongCSRF = await apiRequest(fixtures.baseURL, '/auth/step-up', {
    body: { totp_code: stepUpCode },
    cookie: superAdministrator.cookie,
    csrfToken: csrfProbe,
  });
  expect(wrongCSRF.status).toBe(403);
  expect(errorCode(wrongCSRF)).toBe('CSRF_INVALID');

  const steppedUp = await apiRequest<{ csrf_token: string }>(fixtures.baseURL, '/auth/step-up', {
    body: { totp_code: stepUpCode },
    cookie: superAdministrator.cookie,
    csrfToken: superAdministrator.csrfToken,
  });
  expect(steppedUp.status).toBe(200);
  const replayed = await apiRequest(fixtures.baseURL, '/auth/step-up', {
    body: { totp_code: stepUpCode },
    cookie: superAdministrator.cookie,
    csrfToken: steppedUp.body.csrf_token,
  });
  expect(replayed.status).toBe(401);
  expect(errorCode(replayed)).toBe('AUTH_INVALID_CREDENTIALS');

  const revoked = await apiRequest(fixtures.baseURL, revokePath, {
    body: revokeBody,
    cookie: superAdministrator.cookie,
    csrfToken: steppedUp.body.csrf_token,
  });
  expect(revoked.status).toBe(200);
  const oldOperatorSession = await apiRequest(fixtures.baseURL, '/me', { cookie: operator.cookie });
  expect(oldOperatorSession.status).toBe(401);
  expect(errorCode(oldOperatorSession)).toBe('AUTH_REQUIRED');

  const listed = await apiRequest<{ items: Array<{ id: string; security_version: number; status: string }> }>(
    fixtures.baseURL,
    '/admin-users',
    { cookie: superAdministrator.cookie },
  );
  expect(listed.status).toBe(200);
  expect(listed.body.items.find((item) => item.id === operator.fixture.adminId)).toEqual(
    expect.objectContaining({ security_version: 2, status: 'active' }),
  );
  appendSensitiveCanaries([
    ...canaries,
    { kind: 'csrf_probe', value: csrfProbe },
    { kind: 'totp_code', value: stepUpCode },
    { kind: 'csrf_token', value: steppedUp.body.csrf_token },
  ]);
});
