import { apiRequest } from './http'
import type { ResourceID } from './resources'

export type PublishingCollection =
  'agent-templates' | 'pet-assets' | 'plugin-catalog' | 'skill-catalog'

export type DeliveryResourceType = 'agent' | 'category' | 'plugin' | 'skill'

export type DeliveryStatus =
  | 'local_only'
  | 'draft_synced'
  | 'validation_failed'
  | 'submitted'
  | 'approved'
  | 'released'
  | 'desktop_verified'
  | 'failed'

export interface ContentDeliveryLink {
  id: ResourceID
  resourceType: DeliveryResourceType
  payloadDocumentId: string
  stableKey: string
  cloudDefinitionId?: string | null
  cloudDraftId?: string | null
  cloudSubmissionId?: string | null
  cloudVersionId?: string | null
  cloudReleaseId?: string | null
  contentDigest?: string | null
  runtimeManifestSha256?: string | null
  syncStatus: DeliveryStatus
  lastOperationId?: string | null
  lastRequestId?: string | null
  lastErrorCode?: string | null
  lastErrorSummary?: string | null
  createdAt: string
  updatedAt: string
}

type DeliveryEnvelope = {
  data: ContentDeliveryLink
  meta: Record<string, unknown>
  requestId: string
}

export async function syncAgentToCloud(id: ResourceID): Promise<ContentDeliveryLink> {
  return (
    await apiRequest<DeliveryEnvelope>(`/content-delivery/sync-agent/${id}`, { method: 'POST' })
  ).data
}

export async function validateAgentCloud(id: ResourceID): Promise<ContentDeliveryLink> {
  return (
    await apiRequest<DeliveryEnvelope>(`/content-delivery/validate/${id}`, { method: 'POST' })
  ).data
}

export async function submitAgentForReview(
  id: ResourceID,
  reasonCode: string,
): Promise<ContentDeliveryLink> {
  return (
    await apiRequest<DeliveryEnvelope>(`/content-delivery/submit/${id}`, {
      body: { reason_code: reasonCode },
      method: 'POST',
    })
  ).data
}

export async function getContentDeliveryStatus(
  resourceType: DeliveryResourceType,
  id: ResourceID,
): Promise<ContentDeliveryLink> {
  return (await apiRequest<DeliveryEnvelope>(`/content-delivery/${resourceType}/${id}`)).data
}

export async function publishResource(
  collection: PublishingCollection,
  id: ResourceID,
): Promise<unknown> {
  const result = await apiRequest<{ doc: unknown }>(`/${collection}/${id}?draft=false`, {
    method: 'PATCH',
    body: { _status: 'published' },
  })
  return result.doc
}

export async function saveResourceDraft(
  collection: PublishingCollection,
  id: ResourceID,
): Promise<unknown> {
  const result = await apiRequest<{ doc: unknown }>(`/${collection}/${id}?draft=true`, {
    method: 'PATCH',
    body: { _status: 'draft' },
  })
  return result.doc
}
