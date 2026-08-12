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
