import { callCloud } from './cloud';
import type { components } from './generated/cloud-admin';
import { ApiError, apiRequest } from './http';

type CloudSchemas = components['schemas'];

// Cloud OpenAPI 是官方 Agent wire contract 的唯一类型来源。
export type OfficialDefinition = CloudSchemas['OfficialDefinition'];
export type OfficialDraft = CloudSchemas['OfficialDraft'];
export type OfficialSubmission = CloudSchemas['OfficialSubmission'];
export type OfficialVersion = CloudSchemas['OfficialVersion'];
export type OfficialRelease = CloudSchemas['OfficialRelease'];
export type OfficialAgentAuditEvent = CloudSchemas['OfficialAuditEvent'];
export type OfficialReviewDecision = CloudSchemas['OfficialReview']['decision'];
export type AgentManifest = CloudSchemas['AgentManifest'];
export type AgentManifestV1 = CloudSchemas['AgentManifestV1'];
export type AgentManifestV2 = CloudSchemas['AgentManifestV2'];
export type AgentVersionBundleV1 = CloudSchemas['AgentVersionBundleV1'];
export type OfficialReleaseChannel = NonNullable<
  CloudSchemas['OfficialReviewMutation']['payload']['initial_channels']
>[number];

export type OfficialPage<T> = {
  items: T[];
  next_cursor?: string;
};

export type OfficialOperationOutcome = CloudSchemas['Operation'];
export type DraftValidation = CloudSchemas['OfficialDraftValidation'];
export type OfficialDefinitionPayload = CloudSchemas['OfficialDefinitionMutation']['payload'];
export type OfficialDraftCreatePayload = CloudSchemas['OfficialDraftCreatePayload'];
export type OfficialDraftUpdatePayload = CloudSchemas['OfficialDraftUpdatePayload'];
export type OfficialReviewPayload = CloudSchemas['OfficialReviewMutation']['payload'];
export type OfficialActivatePayload = CloudSchemas['OfficialActivateMutation']['payload'];
export type OfficialRolloutPayload = CloudSchemas['OfficialRolloutMutation']['payload'];

// 官方 Agent 变更统一入参：BFF 会包装成 officialMutationEnvelope 并生成 operation_id。
export type OfficialMutationInput<T = Record<string, unknown>> = {
  expected_revision: number;
  payload: T;
  reason_code: string;
  ticket_reference?: string;
};

type PageQuery = { cursor?: string; limit?: number };

async function listOfficial<T>(operation: string, query: PageQuery, signal?: AbortSignal): Promise<OfficialPage<T>> {
  const result = await callCloud<{ readonly items: readonly T[]; readonly next_cursor?: string }>(operation, {
    params: { cursor: query.cursor, limit: query.limit },
    signal
  });
  return { ...result.data, items: [...result.data.items] };
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
  input: OfficialMutationInput<OfficialDefinitionPayload>
): Promise<OfficialOperationOutcome> {
  const result = await callCloud<OfficialOperationOutcome>('reserveOfficialDefinition', {
    method: 'POST',
    body: input
  });
  return result.data;
}

export async function createOfficialDraft(
  input: OfficialMutationInput<OfficialDraftCreatePayload>
): Promise<OfficialOperationOutcome> {
  const result = await callCloud<OfficialOperationOutcome>('createOfficialDraft', { method: 'POST', body: input });
  return result.data;
}

export async function updateOfficialDraft(
  draftId: string,
  input: OfficialMutationInput<OfficialDraftUpdatePayload>
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
  input: OfficialMutationInput<OfficialReviewPayload>
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
  input: OfficialMutationInput<OfficialActivatePayload>
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
  input: OfficialMutationInput<OfficialRolloutPayload>
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
