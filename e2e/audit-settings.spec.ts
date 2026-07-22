import { expect, test } from '@playwright/test';

import {
  apiRequest,
  appendSensitiveCanaries,
  assertNoSensitiveCanaries,
  generateTOTP,
  loginInBrowser,
  loginWithRecovery,
  readFixtures,
  type APIResult,
  type AuthenticatedRequest,
  type SensitiveCanary,
} from './support';

interface AuditEvent {
  id: string;
  actor_admin_id: string | null;
  event_type: string;
}

interface AuditEventPage {
  items: AuditEvent[];
  next_cursor: string | null;
}

interface SecurityPolicy {
  session_idle_minutes: number;
  session_absolute_hours: number;
  audit_retention_days: number;
  revision: number;
}

interface PolicyMutationResult {
  operation_id: string;
  policy: SecurityPolicy;
  sessions_revoked: boolean;
}

interface ReasonMutationResult {
  operation_id: string;
  reason: { code: string; label: string; active: boolean };
  settings_revision: number;
}

const dynamicReasonCode = 'e2e_staff_review';
const dynamicReasonLabel = 'E2E 人员复核';
let originalPolicy: SecurityPolicy | undefined;

function errorCode(result: APIResult): string | undefined {
  return (result.body as { error?: { code?: string } })?.error?.code;
}

async function stepUp(
  baseURL: string,
  authenticated: AuthenticatedRequest,
  canaries: SensitiveCanary[],
): Promise<AuthenticatedRequest> {
  const totpCode = generateTOTP(authenticated.fixture.totpSecret, 1);
  const result = await apiRequest<{ csrf_token: string }>(baseURL, '/auth/step-up', {
    body: { totp_code: totpCode },
    cookie: authenticated.cookie,
    csrfToken: authenticated.csrfToken,
  });
  expect(result.status).toBe(200);
  // The step-up contract intentionally returns the in-memory CSRF value needed
  // for the retried mutation; it must never echo the submitted TOTP credential.
  assertNoSensitiveCanaries(
    result.raw,
    [{ kind: 'totp_code', value: totpCode }],
    'settings step-up response',
  );
  canaries.push(
    { kind: 'totp_code', value: totpCode },
    { kind: 'csrf_token', value: result.body.csrf_token },
  );
  return { ...authenticated, csrfToken: result.body.csrf_token };
}

function policyBody(policy: SecurityPolicy, overrides: Partial<SecurityPolicy> = {}) {
  return {
    expected_revision: policy.revision,
    session_idle_minutes: overrides.session_idle_minutes ?? policy.session_idle_minutes,
    session_absolute_hours: overrides.session_absolute_hours ?? policy.session_absolute_hours,
    audit_retention_days: overrides.audit_retention_days ?? policy.audit_retention_days,
    reason_code: 'security_policy_change',
    ticket_reference: 'E2E-SETTINGS',
    note: '',
  };
}

test.describe.serial('phase one audit and settings acceptance', () => {
  test('audit queries enforce full and own scopes with filters and cursor pagination', async () => {
    const fixtures = readFixtures();
    const canaries: SensitiveCanary[] = [];
    const targetActor = fixtures.roles.super_admin[0].adminId;
    const superAdministrator = await loginWithRecovery(
      fixtures.baseURL,
      fixtures.roles.super_admin[0],
      1,
      canaries,
    );
    const firstPage = await apiRequest<AuditEventPage>(
      fixtures.baseURL,
      `/audit-events?actor_admin_id=${targetActor}&event_type=admin_invited&outcome=success&limit=1`,
      { cookie: superAdministrator.cookie },
    );
    expect(firstPage.status).toBe(200);
    expect(firstPage.body.items).toHaveLength(1);
    expect(firstPage.body.items[0]?.actor_admin_id).toBe(targetActor);
    expect(firstPage.body.items[0]?.event_type).toBe('admin_invited');
    expect(firstPage.body.next_cursor).toEqual(expect.any(String));

    const secondPage = await apiRequest<AuditEventPage>(
      fixtures.baseURL,
      `/audit-events?actor_admin_id=${targetActor}&event_type=admin_invited&outcome=success&limit=1&cursor=${encodeURIComponent(firstPage.body.next_cursor ?? '')}`,
      { cookie: superAdministrator.cookie },
    );
    expect(secondPage.status).toBe(200);
    expect(secondPage.body.items).toHaveLength(1);
    expect(secondPage.body.items[0]?.id).not.toBe(firstPage.body.items[0]?.id);

    const auditor = await loginWithRecovery(fixtures.baseURL, fixtures.roles.auditor[0], 2, canaries);
    const auditorView = await apiRequest<AuditEventPage>(
      fixtures.baseURL,
      `/audit-events?actor_admin_id=${targetActor}&event_type=admin_invited&limit=10`,
      { cookie: auditor.cookie },
    );
    expect(auditorView.status).toBe(200);
    expect(auditorView.body.items.length).toBeGreaterThan(0);
    expect(auditorView.body.items.every((event) => event.actor_admin_id === targetActor)).toBe(true);

    for (const [role, recoveryIndex] of [['operator', 3], ['support', 3]] as const) {
      const own = await loginWithRecovery(fixtures.baseURL, fixtures.roles[role][0], recoveryIndex, canaries);
      const ownView = await apiRequest<AuditEventPage>(
        fixtures.baseURL,
        `/audit-events?actor_admin_id=${targetActor}&event_type=admin_recovery_code_used&limit=100`,
        { cookie: own.cookie },
      );
      expect(ownView.status).toBe(200);
      expect(ownView.body.items.length).toBeGreaterThan(0);
      expect(ownView.body.items.every((event) => event.actor_admin_id === own.fixture.adminId)).toBe(true);
    }

    for (const role of ['developer', 'finance'] as const) {
      const denied = await loginWithRecovery(fixtures.baseURL, fixtures.roles[role][0], 2, canaries);
      for (const path of ['/audit-events', '/system/settings']) {
        const response = await apiRequest(fixtures.baseURL, path, { cookie: denied.cookie });
        expect(response.status).toBe(403);
        expect(errorCode(response)).toBe('PERMISSION_DENIED');
        assertNoSensitiveCanaries(response.raw, [...fixtures.sensitiveCanaries, ...canaries], `${role} denial response`);
      }
    }

    for (const response of [firstPage, secondPage, auditorView]) {
      assertNoSensitiveCanaries(response.raw, [...fixtures.sensitiveCanaries, ...canaries], 'audit response');
    }
    appendSensitiveCanaries(canaries);
  });

  test('auditor sees the audit console and a read-only settings console', async ({ page }) => {
    const fixtures = readFixtures();
    const canaries: SensitiveCanary[] = [];
    await loginInBrowser(page, fixtures.roles.auditor[0], 3, canaries);

    await page.goto('/audit');
    await expect(page.getByRole('heading', { name: '审计记录' })).toBeVisible();
    await expect(page.getByText('可查看全部管理员审计记录')).toBeVisible();
    await expect(page.getByLabel('操作人 ID')).toBeVisible();

    await page.goto('/system/settings');
    await expect(page.getByRole('heading', { name: '系统安全设置' })).toBeVisible();
    await expect(page.getByText('只读模式')).toBeVisible();
    await expect(page.getByLabel('会话空闲超时（分钟）')).toBeDisabled();
    await expect(page.getByRole('button', { name: '保存安全策略' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /新增原因码/ })).toHaveCount(0);
    appendSensitiveCanaries(canaries);
  });

  test('super administrator settings mutations require step-up and are replay-safe', async () => {
    const fixtures = readFixtures();
    const settingsAdministrator = fixtures.roles.super_admin[3];
    expect(settingsAdministrator, 'dedicated settings administrator fixture').toBeDefined();
    const canaries: SensitiveCanary[] = [];
    let authenticated = await loginWithRecovery(fixtures.baseURL, settingsAdministrator, 0, canaries);
    const current = await apiRequest<SecurityPolicy>(fixtures.baseURL, '/system/settings', {
      cookie: authenticated.cookie,
    });
    expect(current.status).toBe(200);
    originalPolicy = current.body;
    const changedRetention = current.body.audit_retention_days === 3650
      ? current.body.audit_retention_days - 1
      : current.body.audit_retention_days + 1;
    const body = policyBody(current.body, { audit_retention_days: changedRetention });
    const mutationKey = crypto.randomUUID();
    canaries.push({ kind: 'idempotency_key', value: mutationKey });

    const beforeStepUp = await apiRequest(fixtures.baseURL, '/system/settings/security-policy', {
      method: 'PUT',
      body,
      cookie: authenticated.cookie,
      csrfToken: authenticated.csrfToken,
      headers: { 'Idempotency-Key': mutationKey },
    });
    expect(beforeStepUp.status).toBe(403);
    expect(errorCode(beforeStepUp)).toBe('STEP_UP_REQUIRED');

    authenticated = await stepUp(fixtures.baseURL, authenticated, canaries);
    const first = await apiRequest<PolicyMutationResult>(fixtures.baseURL, '/system/settings/security-policy', {
      method: 'PUT', body, cookie: authenticated.cookie, csrfToken: authenticated.csrfToken,
      headers: { 'Idempotency-Key': mutationKey },
    });
    const replay = await apiRequest<PolicyMutationResult>(fixtures.baseURL, '/system/settings/security-policy', {
      method: 'PUT', body, cookie: authenticated.cookie, csrfToken: authenticated.csrfToken,
      headers: { 'Idempotency-Key': mutationKey },
    });
    expect(first.status).toBe(200);
    expect(first.body.sessions_revoked).toBe(false);
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual(first.body);

    const conflict = await apiRequest(fixtures.baseURL, '/system/settings/security-policy', {
      method: 'PUT',
      body: { ...body, audit_retention_days: current.body.audit_retention_days },
      cookie: authenticated.cookie,
      csrfToken: authenticated.csrfToken,
      headers: { 'Idempotency-Key': mutationKey },
    });
    expect(conflict.status).toBe(409);
    expect(errorCode(conflict)).toBe('IDEMPOTENCY_KEY_REUSED');

    const restoreRetentionKey = crypto.randomUUID();
    canaries.push({ kind: 'idempotency_key', value: restoreRetentionKey });
    const restoredRetention = await apiRequest<PolicyMutationResult>(
      fixtures.baseURL,
      '/system/settings/security-policy',
      {
        method: 'PUT',
        body: policyBody(first.body.policy, { audit_retention_days: current.body.audit_retention_days }),
        cookie: authenticated.cookie,
        csrfToken: authenticated.csrfToken,
        headers: { 'Idempotency-Key': restoreRetentionKey },
      },
    );
    expect(restoredRetention.status).toBe(200);
    expect(restoredRetention.body.sessions_revoked).toBe(false);

    const reasonKey = crypto.randomUUID();
    canaries.push({ kind: 'idempotency_key', value: reasonKey });
    const created = await apiRequest<ReasonMutationResult>(fixtures.baseURL, '/system/reason-codes', {
      body: {
        code: dynamicReasonCode,
        category: 'administrator',
        label: dynamicReasonLabel,
        expected_settings_revision: restoredRetention.body.policy.revision,
        reason_code: 'reason_catalog_change',
        ticket_reference: 'E2E-REASON',
        note: '',
      },
      cookie: authenticated.cookie,
      csrfToken: authenticated.csrfToken,
      headers: { 'Idempotency-Key': reasonKey },
    });
    expect(created.status).toBe(201);
    expect(created.body.reason).toEqual(expect.objectContaining({ code: dynamicReasonCode, active: true }));
    const reasons = await apiRequest<{ items: Array<{ code: string }> }>(
      fixtures.baseURL,
      '/system/reason-codes?usage=administrator',
      { cookie: authenticated.cookie },
    );
    expect(reasons.status).toBe(200);
    expect(reasons.body.items.some((reason) => reason.code === dynamicReasonCode)).toBe(true);

    for (const response of [beforeStepUp, first, replay, conflict, restoredRetention, created, reasons]) {
      assertNoSensitiveCanaries(response.raw, [...fixtures.sensitiveCanaries, ...canaries], 'settings mutation response');
    }
    appendSensitiveCanaries(canaries);
  });

  test('dynamic reasons reach business forms and session policy changes revoke every session', async ({ page }) => {
    const fixtures = readFixtures();
    expect(originalPolicy, 'original policy captured by the serial settings test').toBeDefined();
    const canaries: SensitiveCanary[] = [];

    await loginInBrowser(page, fixtures.roles.super_admin[3], 1, canaries);
    await page.goto('/security/admins');
    await page.getByRole('button', { name: '邀请管理员' }).click();
    const reasonSelect = page.getByRole('combobox', { name: '标准原因' });
    await reasonSelect.focus();
    await reasonSelect.press('ArrowDown');
    await expect(page.getByText(dynamicReasonLabel).last()).toBeVisible();

    const auditorSession = await loginWithRecovery(fixtures.baseURL, fixtures.roles.auditor[0], 4, canaries);
    const supportSession = await loginWithRecovery(fixtures.baseURL, fixtures.roles.support[0], 4, canaries);
    const policyAdministrator = fixtures.roles.super_admin[4];
    expect(policyAdministrator, 'dedicated policy administrator fixture').toBeDefined();
    let policyActor = await loginWithRecovery(fixtures.baseURL, policyAdministrator, 0, canaries);
    const current = await apiRequest<SecurityPolicy>(fixtures.baseURL, '/system/settings', {
      cookie: policyActor.cookie,
    });
    expect(current.status).toBe(200);
    policyActor = await stepUp(fixtures.baseURL, policyActor, canaries);
    const changedIdle = current.body.session_idle_minutes === 120
      ? current.body.session_idle_minutes - 1
      : current.body.session_idle_minutes + 1;
    const policyKey = crypto.randomUUID();
    canaries.push({ kind: 'idempotency_key', value: policyKey });
    const changed = await apiRequest<PolicyMutationResult>(fixtures.baseURL, '/system/settings/security-policy', {
      method: 'PUT',
      body: policyBody(current.body, { session_idle_minutes: changedIdle }),
      cookie: policyActor.cookie,
      csrfToken: policyActor.csrfToken,
      headers: { 'Idempotency-Key': policyKey },
    });
    expect(changed.status).toBe(200);
    expect(changed.body.sessions_revoked).toBe(true);

    for (const session of [auditorSession, supportSession, policyActor]) {
      const invalidated = await apiRequest(fixtures.baseURL, '/me', { cookie: session.cookie });
      expect(invalidated.status).toBe(401);
      expect(errorCode(invalidated)).toBe('AUTH_REQUIRED');
    }

    const restoreAdministrator = fixtures.roles.super_admin[5];
    expect(restoreAdministrator, 'dedicated policy restore administrator fixture').toBeDefined();
    let restoreActor = await loginWithRecovery(fixtures.baseURL, restoreAdministrator, 0, canaries);
    const changedPolicy = await apiRequest<SecurityPolicy>(fixtures.baseURL, '/system/settings', {
      cookie: restoreActor.cookie,
    });
    expect(changedPolicy.status).toBe(200);
    restoreActor = await stepUp(fixtures.baseURL, restoreActor, canaries);
    const restoreKey = crypto.randomUUID();
    canaries.push({ kind: 'idempotency_key', value: restoreKey });
    const restored = await apiRequest<PolicyMutationResult>(fixtures.baseURL, '/system/settings/security-policy', {
      method: 'PUT',
      body: policyBody(changedPolicy.body, originalPolicy),
      cookie: restoreActor.cookie,
      csrfToken: restoreActor.csrfToken,
      headers: { 'Idempotency-Key': restoreKey },
    });
    expect(restored.status).toBe(200);
    expect(restored.body.sessions_revoked).toBe(true);
    expect(restored.body.policy).toEqual(expect.objectContaining({
      session_idle_minutes: originalPolicy?.session_idle_minutes,
      session_absolute_hours: originalPolicy?.session_absolute_hours,
      audit_retention_days: originalPolicy?.audit_retention_days,
    }));
    expect((await apiRequest(fixtures.baseURL, '/me', { cookie: restoreActor.cookie })).status).toBe(401);

    for (const response of [current, changed, changedPolicy, restored]) {
      assertNoSensitiveCanaries(response.raw, [...fixtures.sensitiveCanaries, ...canaries], 'session policy response');
    }
    appendSensitiveCanaries(canaries);
  });
});
