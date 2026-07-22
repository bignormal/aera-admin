import { execFileSync } from 'node:child_process';

import type { FullConfig } from '@playwright/test';

import {
  activateInvitation,
  apiRequest,
  expectStatus,
  generateTOTP,
  loginWithRecovery,
  maskedEmail,
  prepareActivation,
  readCloudFixture,
  type AdministratorFixture,
  type E2EFixtures,
  type Role,
  type SensitiveCanary,
  writeFixtures,
} from './support';

const managedRoles = ['developer', 'operator', 'support', 'finance', 'auditor'] as const;

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function bootstrapInvitation(binary: string, email: string, displayName: string): string {
  const output = execFileSync(
    binary,
    ['invite-super-admin', '--email', email, '--display-name', displayName],
    { encoding: 'utf8', env: process.env, stdio: ['ignore', 'pipe', 'pipe'] },
  ).trim();
  if (!output.startsWith('http')) throw new Error('bootstrap command did not return an activation URL');
  return output;
}

function passwordFor(role: string, ordinal: number): string {
  return `Aera-E2E-${role}-${ordinal}-Passphrase-2026-🔐`;
}

export default async function globalSetup(_config: FullConfig): Promise<void> {
  const baseURL = requiredEnvironment('AERA_ADMIN_E2E_BASE_URL');
  const bootstrapBinary = requiredEnvironment('AERA_ADMIN_E2E_BOOTSTRAP_BINARY');
  const cloudFixture = readCloudFixture(requiredEnvironment('AERA_ADMIN_E2E_CLOUD_FIXTURE_FILE'));
  const sensitiveCanaries: SensitiveCanary[] = [];
  sensitiveCanaries.push({ kind: 'cloud_raw_lookup_identity', value: cloudFixture.raw_lookup_identity });
  const roleFixtures: Record<Role, AdministratorFixture[]> = {
    super_admin: [],
    developer: [],
    operator: [],
    support: [],
    finance: [],
    auditor: [],
  };

  for (const [ordinal, displayName] of ['第一超级管理员', '第二超级管理员'].entries()) {
    const index = ordinal + 1;
    const email = `e2e.super${index}.canary@example.test`;
    const password = passwordFor('super-admin', index);
    const invitation = bootstrapInvitation(bootstrapBinary, email, displayName);
    roleFixtures.super_admin.push(
      await activateInvitation(baseURL, invitation, email, password, 'super_admin', sensitiveCanaries),
    );
  }

  const bootstrapActor = await loginWithRecovery(baseURL, roleFixtures.super_admin[0], 0, sensitiveCanaries);
  const bootstrapStepUpCode = generateTOTP(bootstrapActor.fixture.totpSecret, 1);
  const steppedUp = await apiRequest<{ csrf_token: string }>(baseURL, '/auth/step-up', {
    body: { totp_code: bootstrapStepUpCode },
    cookie: bootstrapActor.cookie,
    csrfToken: bootstrapActor.csrfToken,
  });
  expectStatus(steppedUp, 200, 'bootstrap actor step-up');
  sensitiveCanaries.push(
    { kind: 'totp_code', value: bootstrapStepUpCode },
    { kind: 'csrf_token', value: steppedUp.body.csrf_token },
  );
  bootstrapActor.csrfToken = steppedUp.body.csrf_token;

  const cloudReviewerEmail = 'e2e.super3.canary@example.test';
  const cloudReviewerPassword = passwordFor('super-admin', 3);
  const cloudReviewerInvitation = await apiRequest<{ activation_url: string }>(
    baseURL,
    '/admin-users/invitations',
    {
      body: {
        display_name: 'Cloud 审批超级管理员',
        email: cloudReviewerEmail,
        note: '',
        reason_code: 'staff_change',
        role: 'super_admin',
        ticket_reference: 'E2E-CLOUD-REVIEWER',
      },
      cookie: bootstrapActor.cookie,
      csrfToken: bootstrapActor.csrfToken,
    },
  );
  expectStatus(cloudReviewerInvitation, 201, 'invite Cloud approval super administrator');
  roleFixtures.super_admin.push(
    await activateInvitation(
      baseURL,
      cloudReviewerInvitation.body.activation_url,
      cloudReviewerEmail,
      cloudReviewerPassword,
      'super_admin',
      sensitiveCanaries,
    ),
  );

  for (const [ordinal, role] of managedRoles.entries()) {
    const email = `e2e.${role}.canary@example.test`;
    const password = passwordFor(role, ordinal + 1);
    const invited = await apiRequest<{ activation_url: string }>(baseURL, '/admin-users/invitations', {
      body: {
        display_name: `E2E ${role}`,
        email,
        note: '',
        reason_code: 'staff_change',
        role,
        ticket_reference: `E2E-${ordinal + 1}`,
      },
      cookie: bootstrapActor.cookie,
      csrfToken: bootstrapActor.csrfToken,
    });
    expectStatus(invited, 201, `invite ${role}`);
    if (invited.raw.includes(email)) throw new Error(`invite ${role} echoed a raw identity`);
    roleFixtures[role].push(
      await activateInvitation(baseURL, invited.body.activation_url, email, password, role, sensitiveCanaries),
    );
  }

  const candidateEmail = 'e2e.browser-activation.canary@example.test';
  const candidatePassword = passwordFor('browser-activation', 1);
  const candidateInvitation = await apiRequest<{ activation_url: string }>(baseURL, '/admin-users/invitations', {
    body: {
      display_name: '浏览器激活候选人',
      email: candidateEmail,
      note: '',
      reason_code: 'staff_change',
      role: 'support',
      ticket_reference: 'E2E-BROWSER',
    },
    cookie: bootstrapActor.cookie,
    csrfToken: bootstrapActor.csrfToken,
  });
  expectStatus(candidateInvitation, 201, 'invite browser activation candidate');
  const candidate = await prepareActivation(baseURL, candidateInvitation.body.activation_url, candidateEmail);
  sensitiveCanaries.push(
    { kind: 'raw_email', value: candidateEmail },
    { kind: 'password', value: candidatePassword },
    { kind: 'activation_token', value: candidate.token },
    { kind: 'totp_secret', value: candidate.secret },
  );

  const fixtures: E2EFixtures = {
    baseURL,
    browserCandidate: {
      activationURL: candidateInvitation.body.activation_url,
      adminId: candidate.adminId,
      email: candidateEmail,
      maskedIdentity: maskedEmail(candidateEmail),
      password: candidatePassword,
      totpSecret: candidate.secret,
    },
    cloud: {
      maskedEmail: cloudFixture.masked_email,
      rawLookupIdentity: cloudFixture.raw_lookup_identity,
      sessionID: cloudFixture.session_id,
      deviceID: cloudFixture.device_id,
      userID: cloudFixture.user_id,
    },
    roles: roleFixtures,
    sensitiveCanaries,
  };
  writeFixtures(fixtures);
}
