import type { CollectionBeforeValidateHook } from 'payload'

export const deliveryStatuses = [
  'local_only',
  'draft_synced',
  'validation_failed',
  'submitted',
  'approved',
  'released',
  'desktop_verified',
  'failed',
] as const

export type DeliveryStatus = (typeof deliveryStatuses)[number]

const transitions: Record<DeliveryStatus, readonly DeliveryStatus[]> = {
  local_only: ['draft_synced', 'failed'],
  draft_synced: ['validation_failed', 'submitted', 'failed'],
  validation_failed: ['draft_synced', 'failed'],
  submitted: ['approved', 'failed'],
  approved: ['released', 'failed'],
  released: ['desktop_verified', 'failed'],
  desktop_verified: ['released', 'failed'],
  failed: ['draft_synced', 'failed'],
}

export function canAdvanceDeliveryStatus(from: DeliveryStatus, to: DeliveryStatus): boolean {
  return transitions[from].includes(to)
}

export function deliveryStatusFor(input: {
  cloudReleaseId: string | null
  desktopVerified: boolean
  payloadPublished: boolean
}): DeliveryStatus {
  if (input.desktopVerified && input.cloudReleaseId) return 'desktop_verified'
  if (input.cloudReleaseId) return 'released'
  return 'local_only'
}

const deliveryVerificationStatuses = [
  'catalog_visible',
  'signature_verified',
  'compatible',
  'installed',
  'activated',
  'failed',
] as const

const deliveryVerificationErrorCodes = [
  'catalog_unavailable',
  'invalid_response',
  'signature_verification_failed',
  'runtime_incompatible',
  'content_digest_mismatch',
  'installation_failed',
  'activation_failed',
  'cloud_unavailable',
] as const

type DeliveryVerificationStatus = (typeof deliveryVerificationStatuses)[number]
type DeliveryVerificationErrorCode = (typeof deliveryVerificationErrorCodes)[number]

export type DeliveryVerificationStage = {
  verificationStatus: DeliveryVerificationStatus
  errorCode?: DeliveryVerificationErrorCode
  releaseRevisionId?: string
  definitionId?: string
  versionId: string
  contentDigest: string
  deviceCount: number
  runtimeVersion?: string
  desktopVersion?: string
  occurredAt?: string
  receivedAt?: string
  requestId?: string
}

type DeliveryVerificationResult = {
  desktopVerified: boolean
  stages: DeliveryVerificationStage[]
  syncStatus: 'desktop_verified' | 'released'
}

const canonicalUUIDPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

function optionalCanonicalUUID(value: unknown): string | undefined {
  return typeof value === 'string' && canonicalUUIDPattern.test(value) ? value : undefined
}

function optionalCanonicalTimestamp(value: unknown): string | undefined {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    return undefined
  }
  return value
}

function deliveryVerificationStage(
  value: unknown,
  link: {
    cloudDefinitionId?: string | null
    cloudVersionId: string
    contentDigest: string
  },
): DeliveryVerificationStage | undefined {
  const stage = record(value)
  if (!stage) return undefined
  const verificationStatus = stage.verification_status
  const errorCode = stage.error_code
  const versionId = optionalCanonicalUUID(stage.version_id)
  const contentDigest = stage.content_digest
  const deviceCount = stage.device_count
  if (
    typeof verificationStatus !== 'string' ||
    !deliveryVerificationStatuses.includes(verificationStatus as DeliveryVerificationStatus) ||
    versionId !== link.cloudVersionId ||
    contentDigest !== link.contentDigest ||
    typeof deviceCount !== 'number' ||
    !Number.isSafeInteger(deviceCount) ||
    deviceCount < 1
  ) {
    return undefined
  }
  if (
    (verificationStatus === 'failed' &&
      (typeof errorCode !== 'string' ||
        !deliveryVerificationErrorCodes.includes(errorCode as DeliveryVerificationErrorCode))) ||
    (verificationStatus !== 'failed' && errorCode !== undefined)
  ) {
    return undefined
  }
  const definitionId = optionalCanonicalUUID(stage.definition_id)
  if (link.cloudDefinitionId && definitionId !== link.cloudDefinitionId) return undefined
  const normalized: DeliveryVerificationStage = {
    verificationStatus: verificationStatus as DeliveryVerificationStatus,
    versionId,
    contentDigest,
    deviceCount,
  }
  const releaseRevisionId = optionalCanonicalUUID(stage.release_revision_id)
  const occurredAt = optionalCanonicalTimestamp(stage.occurred_at)
  const receivedAt = optionalCanonicalTimestamp(stage.received_at)
  const requestId = optionalCanonicalUUID(stage.request_id)
  if (
    !definitionId ||
    !releaseRevisionId ||
    typeof stage.runtime_version !== 'string' ||
    stage.runtime_version.length < 5 ||
    typeof stage.desktop_version !== 'string' ||
    stage.desktop_version.length < 5 ||
    !occurredAt ||
    !receivedAt ||
    !requestId
  ) {
    return undefined
  }
  normalized.definitionId = definitionId
  normalized.releaseRevisionId = releaseRevisionId
  normalized.runtimeVersion = stage.runtime_version
  normalized.desktopVersion = stage.desktop_version
  normalized.occurredAt = occurredAt
  normalized.receivedAt = receivedAt
  normalized.requestId = requestId
  if (typeof errorCode === 'string') normalized.errorCode = errorCode as DeliveryVerificationErrorCode
  return normalized
}

export function deliveryVerificationForLink(
  link: {
    cloudDefinitionId?: string | null
    cloudReleaseId: string | null
    cloudVersionId: string | null
    contentDigest: string | null
  },
  value: unknown,
): DeliveryVerificationResult {
  const summary = record(value)
  if (
    !summary ||
    !link.cloudReleaseId ||
    !link.cloudVersionId ||
    !link.contentDigest ||
    summary.release_id !== link.cloudReleaseId ||
    !Array.isArray(summary.stages)
  ) {
    return { desktopVerified: false, stages: [], syncStatus: 'released' }
  }
  const stages = summary.stages.flatMap((stage) => {
    const normalized = deliveryVerificationStage(stage, {
      cloudDefinitionId: link.cloudDefinitionId,
      cloudVersionId: link.cloudVersionId!,
      contentDigest: link.contentDigest!,
    })
    return normalized ? [normalized] : []
  })
  if (stages.length !== summary.stages.length) {
    return { desktopVerified: false, stages: [], syncStatus: 'released' }
  }
  const desktopVerified = stages.some((stage) => stage.verificationStatus === 'activated')
  return {
    desktopVerified,
    stages,
    syncStatus: desktopVerified ? 'desktop_verified' : 'released',
  }
}

export type PluginDeliveryStatus =
  'registered' | 'contract_pending' | 'cloud_published' | 'desktop_verified'

/** Until a signed Cloud/Desktop plugin contract exists, only local registration is allowed. */
export const enforcePluginDeliveryStatus: CollectionBeforeValidateHook = ({ data }) => ({
  ...data,
  deliveryStatus: 'registered',
})

export function pluginDeliveryStatus(input: {
  cloudReleaseId: string | null
  desktopContract: boolean
  desktopVerified: boolean
}): PluginDeliveryStatus {
  if (input.desktopVerified && input.desktopContract && input.cloudReleaseId) {
    return 'desktop_verified'
  }
  if (input.cloudReleaseId && input.desktopContract) return 'cloud_published'
  if (input.cloudReleaseId && !input.desktopContract) return 'contract_pending'
  return 'registered'
}

export function canonicalRuntimeManifestHash(runtimeSkillIds: readonly string[]): string {
  // The actual SHA-256 is calculated at the server boundary; this canonical
  // representation is shared by validation and persistence code.
  return [...new Set(runtimeSkillIds)].sort().join('\n')
}

type RelatedDocument = number | string | Record<string, unknown>

export type DeliverableAgentDocument = {
  category?: RelatedDocument | null
  introduction?: string | null
  minimumRuntimeVersion?: string | null
  name?: string | null
  releaseNotes?: string | null
  rolePrompt?: string | null
  skills?: RelatedDocument[] | null
  templateKey?: string | null
}

type RuntimeSkillDocument = {
  active?: boolean | null
  description?: string | null
  distributionClass?: string | null
  key?: string | null
  name?: string | null
  runtimeSkillId?: string | null
}

type CategoryDocument = {
  active?: boolean | null
  key?: string | null
  name?: string | null
}

export type OfficialAgentCloudPackage = {
  bundle: {
    assets: Array<{ content: string; path: string }>
  }
  contentDigest: string
  displayName: string
  manifest: {
    assets: Array<{
      kind: 'skill'
      media_type: 'text/markdown'
      path: string
      sha256: string
    }>
    dependencies: []
    identity: { system_prompt: string }
    model_policy: {
      allowed_models: []
      allowed_providers: []
      mode: 'user_select'
    }
    runtime_compatibility: {
      maximum_version_exclusive: null
      minimum_version: string
    }
    schema_version: 2
    tools: { allowed: []; denied: [] }
  }
  runtimeManifestSha256: string
  stableKey: string
}

export class ContentDeliveryValidationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'ContentDeliveryValidationError'
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function normalizedRuntimeVersion(value: unknown): string | undefined {
  if (typeof value !== 'string' || !/^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value)) {
    return undefined
  }
  return value.startsWith('v') ? value : `v${value}`
}

function runtimeSkillSlug(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim().toLowerCase()
  return /^[a-z0-9][a-z0-9_-]{0,47}$/.test(normalized) ? normalized : undefined
}

function skillDocument(value: RelatedDocument): RuntimeSkillDocument | undefined {
  return record(value) as RuntimeSkillDocument | undefined
}

function skillMarkdown(skill: RuntimeSkillDocument, runtimeSkillId: string): string {
  const name =
    typeof skill.name === 'string' && skill.name.trim() ? skill.name.trim() : runtimeSkillId
  const description =
    typeof skill.description === 'string' && skill.description.trim()
      ? skill.description.trim()
      : `使用 Aera Runtime 已安装的 ${runtimeSkillId} 公开技能。`
  return [
    '---',
    `name: ${runtimeSkillId}`,
    `description: ${JSON.stringify(description)}`,
    'metadata:',
    '  aera:',
    `    runtime_skill_id: ${runtimeSkillId}`,
    '---',
    '',
    `# ${name}`,
    '',
    description,
    '',
  ].join('\n')
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function cloudContentDigest(
  manifest: OfficialAgentCloudPackage['manifest'],
  bundle: OfficialAgentCloudPackage['bundle'],
): string {
  return sha256(`${JSON.stringify(manifest)}\0${JSON.stringify(bundle)}`)
}

export function buildOfficialAgentCloudPackage(
  agent: DeliverableAgentDocument,
): OfficialAgentCloudPackage {
  const stableKey = typeof agent.templateKey === 'string' ? agent.templateKey.trim() : ''
  const displayName = typeof agent.name === 'string' ? agent.name.trim() : ''
  const systemPrompt = typeof agent.rolePrompt === 'string' ? agent.rolePrompt.trim() : ''
  const minimumVersion = normalizedRuntimeVersion(agent.minimumRuntimeVersion)
  const category = record(agent.category) as CategoryDocument | undefined

  if (!/^[a-z0-9][a-z0-9_-]{1,63}$/.test(stableKey)) {
    throw new ContentDeliveryValidationError('INVALID_STABLE_KEY', '官方智能体稳定标识不合法。')
  }
  if (!displayName || displayName.length > 100) {
    throw new ContentDeliveryValidationError('INVALID_DISPLAY_NAME', '官方智能体名称不合法。')
  }
  if (!systemPrompt) {
    throw new ContentDeliveryValidationError('MISSING_ROLE_PROMPT', '请先填写角色提示词。')
  }
  if (!minimumVersion) {
    throw new ContentDeliveryValidationError(
      'INVALID_RUNTIME_VERSION',
      '同步 Cloud 前必须填写合法的最低 Runtime 版本。',
    )
  }
  if (!category || category.active !== true || typeof category.key !== 'string') {
    throw new ContentDeliveryValidationError(
      'CATEGORY_NOT_ACTIVE',
      '同步 Cloud 前必须选择已启用的分类。',
    )
  }

  const runtimeSkillIDs: string[] = []
  const manifestAssets: OfficialAgentCloudPackage['manifest']['assets'] = []
  const bundleAssets: OfficialAgentCloudPackage['bundle']['assets'] = []
  for (const relation of agent.skills ?? []) {
    const skill = skillDocument(relation)
    const runtimeSkillID = runtimeSkillSlug(skill?.runtimeSkillId)
    if (
      !skill ||
      skill.active !== true ||
      skill.distributionClass === 'cloud_proprietary' ||
      !runtimeSkillID
    ) {
      throw new ContentDeliveryValidationError(
        'SKILL_NOT_DELIVERABLE',
        '第一版官方 Agent 只能使用已启用的 runtime_public 技能。',
      )
    }
    const path = `skills/${runtimeSkillID}/SKILL.md`
    const content = skillMarkdown(skill, runtimeSkillID)
    runtimeSkillIDs.push(runtimeSkillID)
    manifestAssets.push({
      kind: 'skill',
      media_type: 'text/markdown',
      path,
      sha256: sha256(content),
    })
    bundleAssets.push({ content, path })
  }

  manifestAssets.sort((left, right) => left.path.localeCompare(right.path))
  bundleAssets.sort((left, right) => left.path.localeCompare(right.path))
  const manifest: OfficialAgentCloudPackage['manifest'] = {
    assets: manifestAssets,
    dependencies: [],
    identity: { system_prompt: systemPrompt },
    model_policy: { allowed_models: [], allowed_providers: [], mode: 'user_select' },
    runtime_compatibility: {
      maximum_version_exclusive: null,
      minimum_version: minimumVersion,
    },
    schema_version: 2,
    tools: { allowed: [], denied: [] },
  }
  const bundle: OfficialAgentCloudPackage['bundle'] = { assets: bundleAssets }

  return {
    bundle,
    contentDigest: cloudContentDigest(manifest, bundle),
    displayName,
    manifest,
    runtimeManifestSha256: sha256(canonicalRuntimeManifestHash(runtimeSkillIDs)),
    stableKey,
  }
}
import { createHash } from 'node:crypto'
