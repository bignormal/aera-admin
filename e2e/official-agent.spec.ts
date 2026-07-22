import { expect, test } from '@playwright/test';

import type {
  OfficialAuditEvent,
  OfficialDefinition,
  OfficialDraft,
  OfficialOperation,
  OfficialRelease,
  OfficialRollbackApproval,
  OfficialSubmission,
  OfficialVersion,
} from '../web/src/api/contracts';
import {
  apiRequest,
  appendSensitiveCanaries,
  assertNoSensitiveCanaries,
  generateTOTP,
  loginWithRecovery,
  readFixtures,
  restartRealCloud,
  stopRealCloud,
  type AuthenticatedRequest,
  type SensitiveCanary,
} from './support';

interface Page<T> {
  items: T[];
  next_cursor?: string;
}

const displayName = 'E2E 官方研究助手';

function errorCode(body: unknown): string | undefined {
  return (body as { error?: { code?: string } })?.error?.code;
}

async function stepUp(
  baseURL: string,
  authenticated: AuthenticatedRequest,
  canaries: SensitiveCanary[],
): Promise<AuthenticatedRequest> {
  const code = generateTOTP(authenticated.fixture.totpSecret, 1);
  const response = await apiRequest<{ csrf_token: string }>(baseURL, '/auth/step-up', {
    body: { totp_code: code },
    cookie: authenticated.cookie,
    csrfToken: authenticated.csrfToken,
  });
  expect(response.status).toBe(200);
  canaries.push({ kind: 'totp_code', value: code }, { kind: 'csrf_token', value: response.body.csrf_token });
  return { ...authenticated, csrfToken: response.body.csrf_token };
}

async function waitForOperation(
  baseURL: string,
  authenticated: AuthenticatedRequest,
  operationID: string,
): Promise<void> {
  await expect.poll(async () => {
    const response = await apiRequest<OfficialOperation>(baseURL, `/operations/${operationID}`, {
      cookie: authenticated.cookie,
    });
    expect(response.status).toBe(200);
    if (response.body.state === 'failed' || response.body.state === 'conflict') {
      throw new Error(
        `official operation ${operationID} ended as ${response.body.state}:${response.body.error_code ?? 'UNKNOWN'}`,
      );
    }
    return response.body.state;
  }, { timeout: 20_000 }).toBe('succeeded');
}

async function enqueue(
  baseURL: string,
  authenticated: AuthenticatedRequest,
  path: string,
  body: unknown,
  method: 'POST' | 'PATCH' = 'POST',
): Promise<OfficialOperation> {
  const response = await apiRequest<OfficialOperation>(baseURL, path, {
    body,
    cookie: authenticated.cookie,
    csrfToken: authenticated.csrfToken,
    method,
    headers: { 'Idempotency-Key': crypto.randomUUID() },
  });
  expect(response.status).toBe(202);
  expect(response.body.state).toBe('queued');
  await waitForOperation(baseURL, authenticated, response.body.operation_id);
  return response.body;
}

async function list<T>(
  baseURL: string,
  authenticated: AuthenticatedRequest,
  path: string,
): Promise<T[]> {
  const response = await apiRequest<Page<T>>(baseURL, path, { cookie: authenticated.cookie });
  expect(response.status).toBe(200);
  expect(Array.isArray(response.body.items)).toBe(true);
  return response.body.items;
}

function manifest(systemPrompt: string) {
  return {
    schema_version: 1,
    identity: { system_prompt: systemPrompt },
    assets: [],
    model_constraints: { allowed_providers: ['openai'], allowed_models: ['gpt-5'] },
    tools: { allowed: [], denied: [] },
    dependencies: [],
    runtime_compatibility: { minimum_version: 'v0.18.0' },
  };
}

function reason(code: string, ticket: string) {
  return { reason_code: code, ticket_reference: ticket, note: '' };
}

async function createDraft(
  baseURL: string,
  developer: AuthenticatedRequest,
  definitionID: string,
  kind: 'initial' | 'next',
  prompt: string,
  baseVersionID?: string,
): Promise<OfficialDraft> {
  await enqueue(baseURL, developer, '/official-agent-drafts', {
    expected_revision: 1,
    ...reason('official_content_review', `E2E-${kind.toUpperCase()}-DRAFT`),
    payload: {
      definition_id: definitionID,
      ...(baseVersionID ? { base_version_id: baseVersionID } : {}),
      kind,
      display_name: displayName,
      manifest: manifest(prompt),
      bundle: { assets: [] },
    },
  });
  const drafts = await list<OfficialDraft>(baseURL, developer, '/official-agent-drafts?limit=100');
  const draft = drafts.find((item) =>
    item.definition_id === definitionID && item.kind === kind && item.status === 'active');
  if (!draft) throw new Error(`${kind} official draft was not returned by real Cloud`);

  const validation = await apiRequest<{ valid: boolean; findings: unknown[] }>(
    baseURL,
    `/official-agent-drafts/${draft.draft_id}/validate`,
    { method: 'POST', cookie: developer.cookie, csrfToken: developer.csrfToken },
  );
  expect(validation.status).toBe(200);
  expect(validation.body).toEqual(expect.objectContaining({ valid: true, findings: [] }));
  return draft;
}

async function updateDraft(
  baseURL: string,
  developer: AuthenticatedRequest,
  draft: OfficialDraft,
  baseVersionID: string,
  prompt: string,
): Promise<OfficialDraft> {
  await enqueue(baseURL, developer, `/official-agent-drafts/${draft.draft_id}`, {
    expected_revision: draft.revision,
    expected_target_digest: draft.content_digest,
    ...reason('official_content_review', 'E2E-NEXT-DRAFT'),
    payload: {
      base_version_id: baseVersionID,
      kind: 'next',
      display_name: displayName,
      manifest: manifest(prompt),
      bundle: { assets: [] },
    },
  }, 'PATCH');
  const drafts = await list<OfficialDraft>(baseURL, developer, '/official-agent-drafts?limit=100');
  const updated = drafts.find((item) => item.draft_id === draft.draft_id && item.kind === 'next' && item.status === 'active');
  if (!updated) throw new Error('updated next official draft was not returned by real Cloud');
  expect(updated.revision).toBe(draft.revision + 1);

  const validation = await apiRequest<{ valid: boolean; findings: unknown[] }>(
    baseURL,
    `/official-agent-drafts/${updated.draft_id}/validate`,
    { method: 'POST', cookie: developer.cookie, csrfToken: developer.csrfToken },
  );
  expect(validation.status).toBe(200);
  expect(validation.body).toEqual(expect.objectContaining({ valid: true, findings: [] }));
  return updated;
}

async function submitDraft(
  baseURL: string,
  developer: AuthenticatedRequest,
  draft: OfficialDraft,
): Promise<OfficialSubmission> {
  await enqueue(baseURL, developer, `/official-agent-drafts/${draft.draft_id}/submit`, {
    expected_revision: draft.revision,
    expected_target_digest: draft.content_digest,
    ...reason('official_content_review', 'E2E-SUBMIT'),
    payload: {},
  });
  const submissions = await list<OfficialSubmission>(
    baseURL,
    developer,
    '/official-agent-submissions?status=pending&limit=50',
  );
  const submission = submissions.find((item) => item.draft_id === draft.draft_id && item.status === 'pending');
  if (!submission) throw new Error('pending official submission was not returned by real Cloud');
  expect(submission.content_digest).toBe(draft.content_digest);
  return submission;
}

async function approveSubmission(
  baseURL: string,
  reviewer: AuthenticatedRequest,
  submission: OfficialSubmission,
): Promise<void> {
  await enqueue(baseURL, reviewer, `/official-agent-submissions/${submission.submission_id}/review`, {
    expected_revision: submission.revision,
    expected_target_digest: submission.content_digest,
    ...reason('official_content_review', 'E2E-REVIEW'),
    payload: { decision: 'approve', initial_channels: ['stable'] },
  });
}

async function currentRelease(
  baseURL: string,
  authenticated: AuthenticatedRequest,
  definitionID: string,
): Promise<OfficialRelease> {
  const releases = await list<OfficialRelease>(baseURL, authenticated, '/official-agent-releases?limit=50');
  const release = releases.find((item) => item.definition_id === definitionID && item.channel === 'stable');
  if (!release) throw new Error('stable official release was not returned by real Cloud');
  return release;
}

test('real Cloud preserves immutable publication, bounded rollout, dual control, and fail-closed state', async () => {
  test.setTimeout(120_000);
  const fixtures = readFixtures();
  const canaries: SensitiveCanary[] = [];
  const developer = await loginWithRecovery(fixtures.baseURL, fixtures.roles.developer[0], 3, canaries);
  let reviewer = await loginWithRecovery(fixtures.baseURL, fixtures.roles.super_admin[6], 0, canaries);
  let operator = await loginWithRecovery(fixtures.baseURL, fixtures.roles.operator[1], 0, canaries);
  const auditor = await loginWithRecovery(fixtures.baseURL, fixtures.roles.auditor[0], 5, canaries);
  reviewer = await stepUp(fixtures.baseURL, reviewer, canaries);
  operator = await stepUp(fixtures.baseURL, operator, canaries);

  await enqueue(fixtures.baseURL, developer, '/official-agents', {
    expected_revision: 1,
    ...reason('official_content_review', 'E2E-DEFINITION'),
    payload: { display_name: displayName },
  });
  const definitions = await list<OfficialDefinition>(fixtures.baseURL, developer, '/official-agents?limit=50');
  const definition = definitions.find((item) => item.display_name === displayName);
  if (!definition) throw new Error('official definition was not returned by real Cloud');

  const v1Draft = await createDraft(
    fixtures.baseURL,
    developer,
    definition.definition_id,
    'initial',
    'You are the approved E2E official research assistant version one.',
  );
  const v1Submission = await submitDraft(fixtures.baseURL, developer, v1Draft);
  await approveSubmission(fixtures.baseURL, reviewer, v1Submission);
  let versions = await list<OfficialVersion>(fixtures.baseURL, reviewer, '/official-agent-versions?limit=100');
  const v1 = versions.find((item) => item.definition_id === definition.definition_id && item.version_number === 1);
  if (!v1) throw new Error('immutable official version one was not published');

  let release = await currentRelease(fixtures.baseURL, operator, definition.definition_id);
  expect(release).toEqual(expect.objectContaining({ state: 'paused', rollout_basis_points: 0, agent_version_id: v1.version_id }));
  await enqueue(fixtures.baseURL, operator, `/official-agent-releases/${release.release_id}/activate`, {
    expected_revision: release.head_revision,
    expected_target_digest: v1.content_digest,
    ...reason('official_rollout_change', 'E2E-V1-ROLLOUT'),
    payload: {
      version_id: v1.version_id,
      rollout_basis_points: 1000,
      minimum_desktop_version: 'v0.18.0',
      allowlisted_user_ids: [fixtures.cloud.officialAudienceUserID],
    },
  });
  release = await currentRelease(fixtures.baseURL, operator, definition.definition_id);
  expect(release).toEqual(expect.objectContaining({ state: 'active', rollout_basis_points: 1000, audience_count: 1 }));
  const v1ReleaseRevisionID = release.current_revision_id;

  const v2Draft = await updateDraft(
    fixtures.baseURL,
    developer,
    v1Draft,
    v1.version_id,
    'You are the approved E2E official research assistant version two.',
  );
  const v2Submission = await submitDraft(fixtures.baseURL, developer, v2Draft);
  const releaseBeforeV2Review = release;
  await approveSubmission(fixtures.baseURL, reviewer, v2Submission);
  versions = await list<OfficialVersion>(fixtures.baseURL, reviewer, '/official-agent-versions?limit=100');
  const v2 = versions.find((item) => item.definition_id === definition.definition_id && item.version_number === 2);
  if (!v2) throw new Error('immutable official version two was not published');
  release = await currentRelease(fixtures.baseURL, operator, definition.definition_id);
  expect(release.current_revision_id).toBe(releaseBeforeV2Review.current_revision_id);
  expect(release.agent_version_id).toBe(v1.version_id);

  await enqueue(fixtures.baseURL, operator, `/official-agent-releases/${release.release_id}/activate`, {
    expected_revision: release.head_revision,
    expected_target_digest: v2.content_digest,
    ...reason('official_rollout_change', 'E2E-V2-ROLLOUT'),
    payload: {
      version_id: v2.version_id,
      rollout_basis_points: 2500,
      minimum_desktop_version: 'v0.18.0',
      allowlisted_user_ids: [fixtures.cloud.officialAudienceUserID],
    },
  });
  release = await currentRelease(fixtures.baseURL, operator, definition.definition_id);
  expect(release).toEqual(expect.objectContaining({ agent_version_id: v2.version_id, rollout_basis_points: 2500 }));

  await enqueue(fixtures.baseURL, operator, `/official-agent-releases/${release.release_id}/pause`, {
    expected_revision: release.head_revision,
    expected_target_digest: v2.content_digest,
    ...reason('official_release_pause', 'E2E-PAUSE'),
    payload: {},
  });
  release = await currentRelease(fixtures.baseURL, operator, definition.definition_id);
  expect(release.state).toBe('paused');
  await enqueue(fixtures.baseURL, operator, `/official-agent-releases/${release.release_id}/resume`, {
    expected_revision: release.head_revision,
    expected_target_digest: v2.content_digest,
    ...reason('official_rollout_change', 'E2E-RESUME'),
    payload: {},
  });
  release = await currentRelease(fixtures.baseURL, operator, definition.definition_id);
  expect(release.state).toBe('active');

  const requested = await apiRequest<OfficialRollbackApproval>(
    fixtures.baseURL,
    `/official-agent-releases/${release.release_id}/rollback-requests`,
    {
      body: {
        target_version_id: v1.version_id,
        target_release_revision_id: v1ReleaseRevisionID,
        expected_head_revision: release.head_revision,
        target_digest: v1.content_digest,
        ...reason('official_release_rollback', 'E2E-ROLLBACK'),
      },
      cookie: operator.cookie,
      csrfToken: operator.csrfToken,
      headers: { 'Idempotency-Key': crypto.randomUUID() },
    },
  );
  expect(requested.status).toBe(201);
  expect(requested.body).toEqual(expect.objectContaining({
    approval_status: 'pending_review',
    execution_status: 'not_started',
  }));

  const approved = await apiRequest<OfficialRollbackApproval>(
    fixtures.baseURL,
    `/official-agent-rollback-requests/${requested.body.id}/approve`,
    {
      body: {},
      cookie: reviewer.cookie,
      csrfToken: reviewer.csrfToken,
      headers: { 'Idempotency-Key': crypto.randomUUID() },
    },
  );
  expect(approved.status).toBe(202);
  expect(approved.body).toEqual(expect.objectContaining({ approval_status: 'approved', execution_status: 'queued' }));
  await expect.poll(async () => {
    const items = await list<OfficialRollbackApproval>(
      fixtures.baseURL,
      reviewer,
      '/official-agent-rollback-requests?view=all&limit=50',
    );
    return items.find((item) => item.id === requested.body.id)?.execution_status;
  }, { timeout: 20_000 }).toBe('succeeded');
  release = await currentRelease(fixtures.baseURL, operator, definition.definition_id);
  expect(release).toEqual(expect.objectContaining({
    agent_version_id: v1.version_id,
    action: 'rollback',
    rollback_target_revision_id: v1ReleaseRevisionID,
  }));

  const audit = await apiRequest<Page<OfficialAuditEvent>>(
    fixtures.baseURL,
    '/official-agent-audit-events?limit=50',
    { cookie: auditor.cookie },
  );
  expect(audit.status).toBe(200);
  expect(audit.body.items.some((item) => item.event_type === 'official_release_rollback')).toBe(true);
  assertNoSensitiveCanaries(audit.raw, [...fixtures.sensitiveCanaries, ...canaries], 'official Agent audit');

  for (const [role, index] of [['support', 5], ['finance', 3]] as const) {
    const denied = await loginWithRecovery(fixtures.baseURL, fixtures.roles[role][0], index, canaries);
    const response = await apiRequest(fixtures.baseURL, '/official-agents?limit=50', { cookie: denied.cookie });
    expect(response.status).toBe(403);
    expect(errorCode(response.body)).toBe('PERMISSION_DENIED');
  }

  await stopRealCloud();
  try {
    const unavailable = await apiRequest(fixtures.baseURL, '/official-agents?limit=50', { cookie: auditor.cookie });
    expect(unavailable.status).toBe(503);
    expect(errorCode(unavailable.body)).toBe('CLOUD_UNAVAILABLE');
  } finally {
    await restartRealCloud();
  }
  await expect.poll(async () => {
    const response = await apiRequest(fixtures.baseURL, '/official-agents?limit=50', { cookie: auditor.cookie });
    return response.status;
  }, { timeout: 20_000 }).toBe(200);
  appendSensitiveCanaries(canaries);
});
