import { callCloud } from './cloud';
import { ApiError, apiRequest } from './http';

// 官方 Agent 生命周期契约，对齐 aera-cloud/internal/adminapi/official_agent.go。
export type OfficialDefinition = {
  created_at: string;
  created_by_admin_id: string;
  definition_id: string;
  display_name: string;
  icon_media_type?: string;
  latest_version_id?: string;
  platform_id: string;
  status: string;
  updated_at: string;
};

export type OfficialDraft = {
  base_version_id?: string;
  bundle: Record<string, unknown>;
  bundle_digest: string;
  content_digest: string;
  created_at: string;
  definition_id: string;
  display_name: string;
  draft_id: string;
  kind: string;
  last_editor_admin_id: string;
  last_editor_role: string;
  manifest: Record<string, unknown>;
  manifest_digest: string;
  platform_id: string;
  revision: number;
  status: string;
  updated_at: string;
};

export type OfficialSubmission = {
  content_digest: string;
  definition_id: string;
  display_name: string;
  draft_id: string;
  draft_revision: number;
  kind: string;
  review?: {
    decision: string;
    reason_code?: string;
    reviewed_at: string;
    reviewer_admin_id: string;
    reviewer_role: string;
    safe_note?: string;
  };
  revision: number;
  status: string;
  submission_id: string;
  submitted_at: string;
  submitted_by_admin_id: string;
  submitted_by_role: string;
  terminal_at?: string;
  updated_at: string;
};

export type OfficialVersion = {
  content_digest: string;
  definition_id: string;
  published_at: string;
  runtime_minimum_version: string;
  version_id: string;
  version_number: number;
};

export type OfficialRelease = {
  action: string;
  actor_admin_id: string;
  actor_admin_role: string;
  agent_version_id: string;
  audience_count: number;
  channel: string;
  created_at: string;
  current_revision_id: string;
  definition_id: string;
  head_revision: number;
  minimum_desktop_version: string;
  platform_id: string;
  reason_code: string;
  release_id: string;
  rollback_target_revision_id?: string;
  rollout_basis_points: number;
  state: string;
  updated_at: string;
};

export type OfficialAgentAuditEvent = {
  action: string;
  actor_admin_id?: string;
  actor_admin_role?: string;
  audit_event_id?: string;
  created_at: string;
  definition_id?: string;
  draft_id?: string;
  operation_id?: string;
  reason_code?: string;
  release_id?: string;
  resource_id?: string;
  resource_type?: string;
  submission_id?: string;
  [key: string]: unknown;
};

export type OfficialPage<T> = {
  items: T[];
  next_cursor?: string;
};

export type OfficialOperationOutcome = {
  operation_id: string;
  [key: string]: unknown;
};

export type DraftValidation = {
  content_digest: string;
  dlp_version: string;
  draft_id: string;
  draft_revision: number;
  findings: Array<Record<string, unknown>>;
  valid: boolean;
};

// 官方 Agent 变更统一入参：BFF 会包装成 officialMutationEnvelope 并生成 operation_id。
export type OfficialMutationInput<T = Record<string, unknown>> = {
  expected_revision: number;
  payload: T;
  reason_code: string;
  ticket_reference?: string;
};

type PageQuery = { cursor?: string; limit?: number };

async function listOfficial<T>(operation: string, query: PageQuery, signal?: AbortSignal): Promise<OfficialPage<T>> {
  const result = await callCloud<OfficialPage<T>>(operation, {
    params: { cursor: query.cursor, limit: query.limit },
    signal
  });
  return result.data;
}

export const listOfficialDefinitions = (query: PageQuery = {}, signal?: AbortSignal) =>
  listOfficial<OfficialDefinition>('listOfficialDefinitions', query, signal);
export const listOfficialDrafts = (query: PageQuery = {}, signal?: AbortSignal) =>
  listOfficial<OfficialDraft>('listOfficialDrafts', query, signal);
export const listOfficialSubmissions = (query: PageQuery = {}, signal?: AbortSignal) =>
  listOfficial<OfficialSubmission>('listOfficialSubmissions', query, signal);
export const listOfficialVersions = (query: PageQuery = {}, signal?: AbortSignal) =>
  listOfficial<OfficialVersion>('listOfficialVersions', query, signal);
export const listOfficialReleases = (query: PageQuery = {}, signal?: AbortSignal) =>
  listOfficial<OfficialRelease>('listOfficialReleases', query, signal);
export const listOfficialAgentAuditEvents = (query: PageQuery = {}, signal?: AbortSignal) =>
  listOfficial<OfficialAgentAuditEvent>('listOfficialAgentAuditEvents', query, signal);

export async function getOfficialDraft(draftId: string, signal?: AbortSignal): Promise<OfficialDraft> {
  const result = await callCloud<OfficialDraft>('getOfficialDraft', { params: { draft_id: draftId }, signal });
  return result.data;
}

export async function validateOfficialDraft(draftId: string): Promise<DraftValidation> {
  const result = await callCloud<DraftValidation>('validateOfficialDraft', {
    method: 'POST',
    params: { draft_id: draftId }
  });
  return result.data;
}

export async function reserveOfficialDefinition(
  input: OfficialMutationInput<{ display_name: string }>
): Promise<OfficialOperationOutcome> {
  const result = await callCloud<OfficialOperationOutcome>('reserveOfficialDefinition', {
    method: 'POST',
    body: input
  });
  return result.data;
}

export async function createOfficialDraft(input: OfficialMutationInput): Promise<OfficialOperationOutcome> {
  const result = await callCloud<OfficialOperationOutcome>('createOfficialDraft', { method: 'POST', body: input });
  return result.data;
}

export async function updateOfficialDraft(
  draftId: string,
  input: OfficialMutationInput
): Promise<OfficialOperationOutcome> {
  const result = await callCloud<OfficialOperationOutcome>('updateOfficialDraft', {
    method: 'PATCH',
    params: { draft_id: draftId },
    body: input
  });
  return result.data;
}

export async function submitOfficialDraft(
  draftId: string,
  input: OfficialMutationInput<Record<string, never>>
): Promise<OfficialOperationOutcome> {
  const result = await callCloud<OfficialOperationOutcome>('submitOfficialDraft', {
    method: 'POST',
    params: { draft_id: draftId },
    body: input
  });
  return result.data;
}

export async function withdrawOfficialSubmission(
  submissionId: string,
  input: OfficialMutationInput<Record<string, never>>
): Promise<OfficialOperationOutcome> {
  const result = await callCloud<OfficialOperationOutcome>('withdrawOfficialSubmission', {
    method: 'POST',
    params: { submission_id: submissionId },
    body: input
  });
  return result.data;
}

export async function reviewOfficialSubmission(
  submissionId: string,
  input: OfficialMutationInput<{
    decision: 'approved' | 'rejected';
    initial_channels?: string[];
    review_reason_code?: string;
    safe_note?: string;
  }>
): Promise<OfficialOperationOutcome> {
  const result = await callCloud<OfficialOperationOutcome>('reviewOfficialSubmission', {
    method: 'POST',
    params: { submission_id: submissionId },
    body: input
  });
  return result.data;
}

export async function activateOfficialRelease(
  releaseId: string,
  input: OfficialMutationInput<{
    allowlisted_user_ids?: string[];
    minimum_desktop_version: string;
    rollout_basis_points: number;
    version_id: string;
  }>
): Promise<OfficialOperationOutcome> {
  const result = await callCloud<OfficialOperationOutcome>('activateOfficialRelease', {
    method: 'POST',
    params: { release_id: releaseId },
    body: input
  });
  return result.data;
}

export async function rolloutOfficialRelease(
  releaseId: string,
  input: OfficialMutationInput<{
    allowlisted_user_ids?: string[];
    minimum_desktop_version: string;
    rollout_basis_points: number;
  }>
): Promise<OfficialOperationOutcome> {
  const result = await callCloud<OfficialOperationOutcome>('rolloutOfficialRelease', {
    method: 'POST',
    params: { release_id: releaseId },
    body: input
  });
  return result.data;
}

export async function pauseOfficialRelease(
  releaseId: string,
  input: OfficialMutationInput<Record<string, never>>
): Promise<OfficialOperationOutcome> {
  const result = await callCloud<OfficialOperationOutcome>('pauseOfficialRelease', {
    method: 'POST',
    params: { release_id: releaseId },
    body: input
  });
  return result.data;
}

export async function resumeOfficialRelease(
  releaseId: string,
  input: OfficialMutationInput<Record<string, never>>
): Promise<OfficialOperationOutcome> {
  const result = await callCloud<OfficialOperationOutcome>('resumeOfficialRelease', {
    method: 'POST',
    params: { release_id: releaseId },
    body: input
  });
  return result.data;
}

export async function executeOfficialRollback(
  releaseId: string,
  approvalRequestId: number | string
): Promise<OfficialOperationOutcome> {
  const result = await callCloud<OfficialOperationOutcome>('rollbackOfficialRelease', {
    method: 'POST',
    params: { release_id: releaseId },
    body: { approval_request_id: approvalRequestId }
  });
  return result.data;
}

// ---- 回滚双人复核（本地 Payload 审批状态机）----
export type RollbackRequest = {
  approvalId: string;
  createdAt: string;
  decidedAt?: string;
  decidedByActorId?: string;
  decisionNote?: string;
  executedAt?: string;
  expectedRevision: number;
  id: number | string;
  operationId?: string;
  reasonCode: string;
  releaseId: string;
  requestedByActorId: string;
  status: 'approved' | 'cancelled' | 'executed' | 'rejected' | 'requested';
  targetReleaseRevisionId: string;
  targetVersionId: string;
  ticketReference?: string;
};

function rollbackError(error: unknown): Error {
  if (error instanceof ApiError) {
    const body =
      error.responseBody && typeof error.responseBody === 'object'
        ? (error.responseBody as { error?: { message?: string } })
        : {};
    return new Error(body.error?.message || error.message);
  }
  return new Error('回滚审批请求失败');
}

export async function listRollbackRequests(signal?: AbortSignal): Promise<RollbackRequest[]> {
  const result = await apiRequest<{ docs: RollbackRequest[] }>(
    '/official-rollback-requests?limit=100&sort=-createdAt&depth=0',
    { signal }
  );
  return result.docs;
}

export async function createRollbackRequest(input: {
  expected_revision: number;
  reason_code: string;
  release_id: string;
  target_release_revision_id: string;
  target_version_id: string;
  ticket_reference?: string;
}): Promise<RollbackRequest> {
  try {
    const result = await apiRequest<{ data: RollbackRequest }>('/official-rollback-requests/create', {
      method: 'POST',
      body: input
    });
    return result.data;
  } catch (error) {
    throw rollbackError(error);
  }
}

export async function decideRollbackRequest(
  id: number | string,
  decision: 'approve' | 'reject',
  note?: string
): Promise<RollbackRequest> {
  try {
    const result = await apiRequest<{ data: RollbackRequest }>(
      `/official-rollback-requests/${encodeURIComponent(String(id))}/decide`,
      { method: 'POST', body: { decision, note } }
    );
    return result.data;
  } catch (error) {
    throw rollbackError(error);
  }
}

export async function cancelRollbackRequest(id: number | string): Promise<RollbackRequest> {
  try {
    const result = await apiRequest<{ data: RollbackRequest }>(
      `/official-rollback-requests/${encodeURIComponent(String(id))}/cancel`,
      { method: 'POST' }
    );
    return result.data;
  } catch (error) {
    throw rollbackError(error);
  }
}
