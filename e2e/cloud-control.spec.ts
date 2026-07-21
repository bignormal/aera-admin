import { expect, test, type Page } from '@playwright/test';

import {
  apiRequest,
  appendSensitiveCanaries,
  generateTOTP,
  loginWithRecovery,
  readFixtures,
  type AdministratorFixture,
  type SensitiveCanary,
} from './support';

test('support exact-searches a masked identity without browser or log persistence', async ({ page }) => {
  const fixtures = readFixtures();
  const support = fixtures.roles.support[0];
  await loginInBrowser(page, support, 1);
  await page.goto('/cloud/users');
  await page.getByLabel('完整邮箱或手机号').fill(fixtures.cloud.rawLookupIdentity);
  const responsePromise = page.waitForResponse((response) =>
    response.url().endsWith('/api/v1/cloud-users/lookup'),
  );
  await page.getByRole('button', { name: '精确查找' }).click();
  const response = await responsePromise;

  expect(response.status()).toBe(200);
  expect(response.url()).not.toContain(fixtures.cloud.rawLookupIdentity);
  expect(await response.text()).not.toContain(fixtures.cloud.rawLookupIdentity);
  await expect(page.getByText(fixtures.cloud.maskedEmail).first()).toBeVisible();
  await expect(page.getByLabel('完整邮箱或手机号')).toHaveValue('');
  expect(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length }))).toEqual({
    local: 0,
    session: 0,
  });
  const sessionCookie = (await page.context().cookies()).find(
    (cookie) => cookie.name === '__Host-aera_admin_session',
  );
  appendSensitiveCanaries([{ kind: 'session_token', value: sessionCookie?.value ?? '' }]);
});

test('support session revoke is idempotent and completes through the outbox', async () => {
  const fixtures = readFixtures();
  const canaries: SensitiveCanary[] = [];
  const support = await loginWithRecovery(fixtures.baseURL, fixtures.roles.support[0], 2, canaries);
  const stepCode = generateTOTP(support.fixture.totpSecret, 1);
  const stepped = await apiRequest<{ csrf_token: string }>(fixtures.baseURL, '/auth/step-up', {
    body: { totp_code: stepCode },
    cookie: support.cookie,
    csrfToken: support.csrfToken,
  });
  expect(stepped.status).toBe(200);
  const idempotencyKey = crypto.randomUUID();
  const body = {
    expected_revision: 1,
    reason_code: 'session_cleanup',
    ticket_reference: 'E2E-SESSION-01',
    note: '',
  };
  const first = await apiRequest<{ operation_id: string; state: string }>(
    fixtures.baseURL,
    `/cloud-sessions/${fixtures.cloud.sessionID}/revoke`,
    {
      body,
      cookie: support.cookie,
      csrfToken: stepped.body.csrf_token,
      headers: { 'Idempotency-Key': idempotencyKey },
    },
  );
  const replay = await apiRequest<{ operation_id: string; state: string }>(
    fixtures.baseURL,
    `/cloud-sessions/${fixtures.cloud.sessionID}/revoke`,
    {
      body,
      cookie: support.cookie,
      csrfToken: stepped.body.csrf_token,
      headers: { 'Idempotency-Key': idempotencyKey },
    },
  );

  expect(first.status).toBe(202);
  expect(replay.status).toBe(202);
  expect(replay.body.operation_id).toBe(first.body.operation_id);
  await expect.poll(async () => {
    const result = await apiRequest<{ state: string }>(
      fixtures.baseURL,
      `/operations/${first.body.operation_id}`,
      { cookie: support.cookie },
    );
    return result.body.state;
  }).toBe('succeeded');
  appendSensitiveCanaries([
    ...canaries,
    { kind: 'totp_code', value: stepCode },
    { kind: 'csrf_token', value: stepped.body.csrf_token },
  ]);
});

test('operator request and different super-admin approval remain separate from execution', async () => {
  const fixtures = readFixtures();
  const canaries: SensitiveCanary[] = [];
  const operator = await loginWithRecovery(fixtures.baseURL, fixtures.roles.operator[0], 2, canaries);
  const operatorStepCode = generateTOTP(operator.fixture.totpSecret, 1);
  const operatorStepped = await apiRequest<{ csrf_token: string }>(fixtures.baseURL, '/auth/step-up', {
    body: { totp_code: operatorStepCode },
    cookie: operator.cookie,
    csrfToken: operator.csrfToken,
  });
  expect(operatorStepped.status).toBe(200);
  const created = await apiRequest<{
    id: string;
    approval_status: string;
    execution_status: string;
  }>(fixtures.baseURL, '/approval-requests', {
    body: {
      action: 'disable_user',
      target_user_id: fixtures.cloud.userID,
      reason_code: 'policy_violation',
      ticket_reference: 'E2E-CLOUD-01',
      note: '',
    },
    cookie: operator.cookie,
    csrfToken: operatorStepped.body.csrf_token,
  });
  expect(created.status).toBe(201);
  expect(created.body).toEqual(
    expect.objectContaining({ approval_status: 'pending_review', execution_status: 'not_started' }),
  );

  const reviewer = await loginWithRecovery(fixtures.baseURL, fixtures.roles.super_admin[2], 0, canaries);
  const reviewerStepCode = generateTOTP(reviewer.fixture.totpSecret, 1);
  const reviewerStepped = await apiRequest<{ csrf_token: string }>(fixtures.baseURL, '/auth/step-up', {
    body: { totp_code: reviewerStepCode },
    cookie: reviewer.cookie,
    csrfToken: reviewer.csrfToken,
  });
  expect(reviewerStepped.status).toBe(200);
  const approved = await apiRequest<{
    operation_id: string;
    approval_status: string;
    execution_status: string;
  }>(fixtures.baseURL, `/approval-requests/${created.body.id}/approve`, {
    body: {},
    cookie: reviewer.cookie,
    csrfToken: reviewerStepped.body.csrf_token,
    headers: { 'Idempotency-Key': crypto.randomUUID() },
  });
  expect(approved.status).toBe(202);
  expect(approved.body.approval_status).toBe('approved');
  expect(approved.body.execution_status).toBe('queued');
  await expect.poll(async () => {
    const result = await apiRequest<{ execution_status: string }>(
      fixtures.baseURL,
      `/approval-requests/${created.body.id}`,
      { cookie: reviewer.cookie },
    );
    return result.body.execution_status;
  }).toBe('succeeded');
  appendSensitiveCanaries([
    ...canaries,
    { kind: 'totp_code', value: operatorStepCode },
    { kind: 'totp_code', value: reviewerStepCode },
    { kind: 'csrf_token', value: operatorStepped.body.csrf_token },
    { kind: 'csrf_token', value: reviewerStepped.body.csrf_token },
  ]);
});

test('every unauthorized fixed role receives API 403 for Cloud mutations', async () => {
  const fixtures = readFixtures();
  const canaries: SensitiveCanary[] = [];
  for (const role of ['developer', 'finance', 'auditor'] as const) {
    const authenticated = await loginWithRecovery(fixtures.baseURL, fixtures.roles[role][0], 1, canaries);
    const result = await apiRequest(fixtures.baseURL, `/cloud-sessions/${fixtures.cloud.sessionID}/revoke`, {
      body: {
        expected_revision: 1,
        reason_code: 'session_cleanup',
        ticket_reference: '',
        note: '',
      },
      cookie: authenticated.cookie,
      csrfToken: authenticated.csrfToken,
      headers: { 'Idempotency-Key': crypto.randomUUID() },
    });
    expect(result.status).toBe(403);
    expect((result.body as { error: { code: string } }).error.code).toBe('PERMISSION_DENIED');
  }
  appendSensitiveCanaries(canaries);
});

async function loginInBrowser(
  page: Page,
  fixture: AdministratorFixture,
  recoveryIndex: number,
): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('内部邮箱').fill(fixture.email);
  await page.getByLabel('密码').fill(fixture.password);
  await page.getByRole('button', { name: /继\s*续/ }).click();
  await page.getByRole('button', { name: '使用恢复码' }).click();
  await page.getByLabel('恢复码').fill(fixture.recoveryCodes[recoveryIndex]);
  await page.getByRole('button', { name: /安\s*全\s*登\s*录/ }).click();
  await expect(page.getByRole('heading', { name: '内部运营工作台' })).toBeVisible();
}
