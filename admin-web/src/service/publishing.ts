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

export type DeliveryVerificationStatus =
  | 'activated'
  | 'catalog_visible'
  | 'compatible'
  | 'failed'
  | 'installed'
  | 'signature_verified'

export type DeliveryVerificationErrorCode =
  | 'activation_failed'
  | 'catalog_unavailable'
  | 'cloud_unavailable'
  | 'content_digest_mismatch'
  | 'installation_failed'
  | 'invalid_response'
  | 'runtime_incompatible'
  | 'signature_verification_failed'

export interface DeliveryVerificationStage {
  verificationStatus: DeliveryVerificationStatus
  errorCode?: DeliveryVerificationErrorCode
  releaseRevisionId?: string
  definitionId?: string
  versionId?: string
  contentDigest?: string
  deviceCount: number
  runtimeVersion?: string
  desktopVersion?: string
  occurredAt?: string
  receivedAt?: string
  requestId?: string
}

export interface DeliveryVerification {
  desktopVerified: boolean
  stages: DeliveryVerificationStage[]
  syncStatus: 'desktop_verified' | 'released'
}

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
  desktopVerification?: DeliveryVerification | null
  lastOperationId?: string | null
  lastRequestId?: string | null
  lastErrorCode?: string | null
  lastErrorSummary?: string | null
  createdAt: string
  updatedAt: string
}

export type DesktopDeliveryTimelineStage = {
  key: 'activated' | 'catalog_visible' | 'cloud_released' | 'compatible' | 'failed' | 'installed' | 'signature_verified'
  label: string
  state: 'complete' | 'failed' | 'pending'
  stage?: DeliveryVerificationStage
}

export type DesktopDeliveryTimeline = {
  delivered: boolean
  stages: DesktopDeliveryTimelineStage[]
  summary: 'Desktop 已激活' | 'Desktop 验证失败' | '已发布，等待 Desktop 验证' | '未发布到 Cloud'
}

const desktopStageLabels: Record<Exclude<DeliveryVerificationStatus, 'failed'>, string> = {
  catalog_visible: 'Desktop 已看到目录',
  signature_verified: '签名已验证',
  compatible: '兼容性通过',
  installed: '已安装',
  activated: '已激活',
}

export function desktopDeliveryTimeline(
  link: Pick<ContentDeliveryLink, 'cloudReleaseId' | 'desktopVerification' | 'syncStatus'>,
): DesktopDeliveryTimeline {
  if (!link.cloudReleaseId) return { delivered: false, stages: [], summary: '未发布到 Cloud' }
  const byStatus = new Map(
    (link.desktopVerification?.stages || []).map((stage) => [stage.verificationStatus, stage] as const),
  )
  const stages: DesktopDeliveryTimelineStage[] = [
    { key: 'cloud_released', label: 'Cloud 已发布', state: 'complete' },
    ...(
      ['catalog_visible', 'signature_verified', 'compatible', 'installed', 'activated'] as const
    ).map((key) => ({
      key,
      label: desktopStageLabels[key],
      stage: byStatus.get(key),
      state: byStatus.has(key) ? ('complete' as const) : ('pending' as const),
    })),
  ]
  const failed = byStatus.get('failed')
  if (failed) stages.push({ key: 'failed', label: '验证失败', stage: failed, state: 'failed' })
  const delivered = link.syncStatus === 'desktop_verified' && byStatus.has('activated')
  return {
    delivered,
    stages,
    summary: delivered ? 'Desktop 已激活' : failed ? 'Desktop 验证失败' : '已发布，等待 Desktop 验证',
  }
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
