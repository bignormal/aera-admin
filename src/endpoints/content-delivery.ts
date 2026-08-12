import { randomUUID } from 'node:crypto'
import type { Endpoint, PayloadHandler, PayloadRequest } from 'payload'

import { hasCapability, type Capability } from '../access/capabilities'
import {
  buildOfficialAgentCloudPackage,
  ContentDeliveryValidationError,
  deliveryVerificationForLink,
  type DeliveryStatus,
} from '../domain/content-delivery'
import { appendAuditLog } from '../domain/audit'
import { createCloudHandler } from '../platform-api/cloud/handler'
import { cloudOperations, type CloudOperationKey } from '../platform-api/cloud/operations'

type CloudEnvelope = {
  data: unknown
  meta?: Record<string, unknown>
  requestId: string
}

type CloudExecutionInput = {
  body?: unknown
  operation: CloudOperationKey
  params?: Record<string, string>
}

export type ContentDeliveryCloudExecutor = (
  req: PayloadRequest,
  input: CloudExecutionInput,
) => Promise<CloudEnvelope>

type DeliveryLink = Record<string, unknown> & {
  cloudDefinitionId?: string | null
  cloudDraftId?: string | null
  cloudSubmissionId?: string | null
  cloudVersionId?: string | null
  cloudReleaseId?: string | null
  contentDigest?: string | null
  id: number | string
  payloadDocumentId: string
  stableKey: string
  syncStatus: DeliveryStatus
}

type CloudOperationResult = {
  administrative_revision?: number
  operation_id: string
  status: 'conflict' | 'executing' | 'failed' | 'queued' | 'succeeded'
  target_id?: string
  target_type?: string
  updated_at: string
}

type CloudDraft = {
  content_digest: string
  definition_id: string
  draft_id: string
  revision: number
  status: string
}

type CloudSubmission = {
  content_digest: string
  definition_id: string
  status: string
  submission_id: string
}

type CloudDeliveryTargetRelease = {
  channel: string
  current_revision_id: string
  release_id: string
  state: string
  version_id: string
}

type CloudDeliveryTarget = {
  content_digest: string
  definition_id: string
  releases: CloudDeliveryTargetRelease[]
  submission_id: string
  version_id: string
}

const requestIDPattern = /^[A-Za-z0-9._:-]{1,128}$/
const resourceIDPattern = /^[A-Za-z0-9_-]{1,64}$/
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const reasonCodePattern = /^[a-z][a-z0-9_]{2,63}$/

class DeliveryEndpointError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly requestId?: string,
  ) {
    super(message)
    this.name = 'DeliveryEndpointError'
  }
}

function requestID(req: PayloadRequest): string {
  const supplied = req.headers?.get('x-request-id')?.trim()
  return supplied && requestIDPattern.test(supplied) ? supplied : randomUUID()
}

function failure(requestId: string, status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message }, requestId }, { status })
}

function routeParam(req: PayloadRequest, name: string): string {
  const value = req.routeParams?.[name]
  return typeof value === 'string' ? value : ''
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function operationResult(value: unknown): CloudOperationResult | undefined {
  const data = record(value)
  if (
    !data ||
    typeof data.operation_id !== 'string' ||
    typeof data.status !== 'string' ||
    typeof data.updated_at !== 'string'
  ) {
    return undefined
  }
  return data as unknown as CloudOperationResult
}

function cloudDraft(value: unknown): CloudDraft | undefined {
  const data = record(value)
  if (
    !data ||
    typeof data.draft_id !== 'string' ||
    typeof data.definition_id !== 'string' ||
    typeof data.content_digest !== 'string' ||
    typeof data.revision !== 'number' ||
    typeof data.status !== 'string'
  ) {
    return undefined
  }
  return data as unknown as CloudDraft
}

function cloudSubmission(value: unknown): CloudSubmission | undefined {
  const data = record(value)
  if (
    !data ||
    typeof data.submission_id !== 'string' ||
    typeof data.definition_id !== 'string' ||
    typeof data.content_digest !== 'string' ||
    typeof data.status !== 'string'
  ) {
    return undefined
  }
  return data as unknown as CloudSubmission
}

function cloudDeliveryTarget(value: unknown): CloudDeliveryTarget | undefined {
  const data = record(value)
  if (
    !data ||
    typeof data.submission_id !== 'string' ||
    typeof data.definition_id !== 'string' ||
    typeof data.content_digest !== 'string' ||
    typeof data.version_id !== 'string' ||
    !Array.isArray(data.releases)
  ) {
    return undefined
  }
  const releases: CloudDeliveryTargetRelease[] = []
  for (const value of data.releases) {
    const release = record(value)
    if (
      !release ||
      typeof release.release_id !== 'string' ||
      typeof release.current_revision_id !== 'string' ||
      typeof release.version_id !== 'string' ||
      typeof release.channel !== 'string' ||
      typeof release.state !== 'string'
    ) {
      return undefined
    }
    releases.push(release as unknown as CloudDeliveryTargetRelease)
  }
  return { ...(data as unknown as CloudDeliveryTarget), releases }
}

function relationID(value: unknown): number | string | undefined {
  if (typeof value === 'number' || typeof value === 'string') return value
  const data = record(value)
  const id = data?.id
  return typeof id === 'number' || typeof id === 'string' ? id : undefined
}

async function hydrateAgent(req: PayloadRequest, id: string): Promise<Record<string, unknown>> {
  let agent: Record<string, unknown>
  try {
    agent = (await req.payload.findByID({
      collection: 'agent-templates',
      depth: 2,
      draft: true,
      id,
      overrideAccess: true,
      req,
    })) as unknown as Record<string, unknown>
  } catch {
    throw new DeliveryEndpointError(404, 'AGENT_NOT_FOUND', '官方智能体草稿不存在。')
  }

  const categoryID = relationID(agent.category)
  if (categoryID !== undefined && !record(agent.category)) {
    agent.category = await req.payload.findByID({
      collection: 'expert-categories',
      depth: 0,
      id: categoryID,
      overrideAccess: true,
      req,
    })
  }
  const skills = []
  for (const value of Array.isArray(agent.skills) ? agent.skills : []) {
    const skillID = relationID(value)
    if (skillID === undefined) continue
    skills.push(
      record(value)
        ? value
        : await req.payload.findByID({
            collection: 'skill-catalog',
            depth: 0,
            id: skillID,
            overrideAccess: true,
            req,
          }),
    )
  }
  agent.skills = skills
  return agent
}

async function findLink(
  req: PayloadRequest,
  resourceType: string,
  id: string,
): Promise<DeliveryLink | undefined> {
  const result = await req.payload.find({
    collection: 'content-delivery-links',
    depth: 0,
    limit: 1,
    overrideAccess: true,
    req,
    where: {
      and: [{ resourceType: { equals: resourceType } }, { payloadDocumentId: { equals: id } }],
    },
  })
  return result.docs[0] as unknown as DeliveryLink | undefined
}

async function saveLink(
  req: PayloadRequest,
  current: DeliveryLink | undefined,
  data: Record<string, unknown>,
): Promise<DeliveryLink> {
  if (current) {
    return (await req.payload.update({
      collection: 'content-delivery-links',
      data,
      id: current.id,
      overrideAccess: true,
      req,
    })) as unknown as DeliveryLink
  }
  return (await req.payload.create({
    collection: 'content-delivery-links',
    data: data as never,
    overrideAccess: true,
    req,
  })) as unknown as DeliveryLink
}

function safeLink(value: DeliveryLink): Record<string, unknown> {
  const allowed = [
    'id',
    'resourceType',
    'payloadDocumentId',
    'stableKey',
    'cloudDefinitionId',
    'cloudDraftId',
    'cloudSubmissionId',
    'cloudVersionId',
    'cloudReleaseId',
    'payloadRevision',
    'contentDigest',
    'runtimeManifestSha256',
    'syncStatus',
    'lastOperationId',
    'lastRequestId',
    'lastErrorCode',
    'lastErrorSummary',
    'desktopVerification',
    'createdAt',
    'updatedAt',
  ]
  return Object.fromEntries(allowed.flatMap((key) => (key in value ? [[key, value[key]]] : [])))
}

function requireCapability(req: PayloadRequest, capability: Capability): void {
  if (!req.user) throw new DeliveryEndpointError(401, 'UNAUTHENTICATED', '请先登录管理后台。')
  if (!hasCapability(req.user.role, capability)) {
    throw new DeliveryEndpointError(403, 'FORBIDDEN', '当前角色无权执行该操作。')
  }
}

function targetID(result: CloudOperationResult, expectedType: string): string {
  if (result.status !== 'succeeded') {
    throw new DeliveryEndpointError(202, 'CLOUD_OPERATION_PENDING', 'Cloud 操作结果待确认。')
  }
  if (result.target_type !== expectedType || !uuidPattern.test(result.target_id ?? '')) {
    throw new DeliveryEndpointError(502, 'CLOUD_TARGET_MISSING', 'Cloud 未返回可验证的目标标识。')
  }
  return result.target_id!
}

function mapError(error: unknown, fallbackRequestId: string): Response {
  if (error instanceof ContentDeliveryValidationError) {
    return failure(fallbackRequestId, 422, error.code, error.message)
  }
  if (error instanceof DeliveryEndpointError) {
    return failure(error.requestId ?? fallbackRequestId, error.status, error.code, error.message)
  }
  return failure(fallbackRequestId, 502, 'CONTENT_DELIVERY_FAILED', '内容交付操作失败。')
}

function defaultCloudExecutor(): ContentDeliveryCloudExecutor {
  const handler = createCloudHandler()
  return async (req, input) => {
    const operation = cloudOperations[input.operation]
    const query = new URLSearchParams(input.params ?? {})
    const derived = {
      ...req,
      json: async () => input.body,
      method: operation.method,
      routeParams: { operation: input.operation },
      url: `http://localhost/api/cloud/v1/${input.operation}${query.size ? `?${query}` : ''}`,
    } as PayloadRequest
    const response = await handler(derived)
    const body = (await response.json()) as Record<string, unknown>
    if (!response.ok) {
      const error = record(body.error)
      throw new DeliveryEndpointError(
        response.status,
        typeof error?.code === 'string' ? error.code : 'CLOUD_OPERATION_FAILED',
        typeof error?.message === 'string' ? error.message : 'Aera Cloud 管理服务暂时不可用。',
        typeof body.requestId === 'string' ? body.requestId : undefined,
      )
    }
    return body as CloudEnvelope
  }
}

async function auditDelivery(
  req: PayloadRequest,
  action: string,
  link: DeliveryLink,
  requestId: string,
): Promise<void> {
  await appendAuditLog(req, {
    action,
    after: safeLink(link),
    capability: 'official-agents:draft:write',
    operationId: typeof link.lastOperationId === 'string' ? link.lastOperationId : undefined,
    outcome: 'succeeded',
    requestId,
    resourceId: link.payloadDocumentId,
    resourceName: link.stableKey,
    resourceType: 'content-delivery',
  })
}

async function reconcileReleasedAgentLink(
  req: PayloadRequest,
  link: DeliveryLink,
  executeCloud: ContentDeliveryCloudExecutor,
): Promise<DeliveryLink> {
  if (
    typeof link.cloudDefinitionId !== 'string' ||
    typeof link.cloudSubmissionId !== 'string' ||
    typeof link.contentDigest !== 'string'
  ) {
    return link
  }

  const targetEnvelope = await executeCloud(req, {
    operation: 'getOfficialSubmission',
    params: { submission_id: link.cloudSubmissionId },
  })
  const submission = cloudSubmission(targetEnvelope.data)
  if (
    !submission ||
    submission.submission_id !== link.cloudSubmissionId ||
    submission.definition_id !== link.cloudDefinitionId ||
    submission.content_digest !== link.contentDigest ||
    submission.status !== 'approved'
  ) {
    return link
  }

  const deliveryEnvelope = await executeCloud(req, {
    operation: 'getOfficialDeliveryTarget',
    params: { submission_id: link.cloudSubmissionId },
  })
  const target = cloudDeliveryTarget(deliveryEnvelope.data)
  if (
    !target ||
    target.submission_id !== link.cloudSubmissionId ||
    target.definition_id !== link.cloudDefinitionId ||
    target.content_digest !== link.contentDigest ||
    !uuidPattern.test(target.version_id) ||
    target.releases.some((release) => release.version_id !== target.version_id)
  ) {
    return link
  }

  const active = target.releases.filter((release) => release.state === 'active')
  const release = active.find((item) => item.channel === 'internal') ?? active[0]
  if (!release) {
    return saveLink(req, link, {
      cloudReleaseId: null,
      cloudVersionId: target.version_id,
      lastErrorCode: null,
      lastErrorSummary: null,
      lastRequestId: deliveryEnvelope.requestId,
      syncStatus: 'approved',
    })
  }

  return saveLink(req, link, {
    cloudReleaseId: release.release_id,
    cloudVersionId: target.version_id,
    lastErrorCode: null,
    lastErrorSummary: null,
    lastRequestId: deliveryEnvelope.requestId,
    syncStatus: 'released',
  })
}

export function createContentDeliveryEndpoints(
  executeCloud: ContentDeliveryCloudExecutor = defaultCloudExecutor(),
): Endpoint[] {
  const syncAgent: PayloadHandler = async (req) => {
    const currentRequestID = requestID(req)
    try {
      requireCapability(req, 'official-agents:draft:write')
      const id = routeParam(req, 'id')
      if (!resourceIDPattern.test(id)) {
        throw new DeliveryEndpointError(400, 'INVALID_RESOURCE_ID', '官方智能体编号不合法。')
      }
      const agent = await hydrateAgent(req, id)
      const content = buildOfficialAgentCloudPackage(agent)
      let link = await findLink(req, 'agent', id)
      let definitionID = link?.cloudDefinitionId ?? undefined
      let lastOperationID: string | undefined

      if (!definitionID) {
        const envelope = await executeCloud(req, {
          body: {
            expected_revision: 1,
            payload: { display_name: content.displayName },
            reason_code: 'content_definition_sync',
          },
          operation: 'reserveOfficialDefinition',
        })
        const result = operationResult(envelope.data)
        if (!result)
          throw new DeliveryEndpointError(502, 'CLOUD_RESPONSE_INVALID', 'Cloud 回执格式不合法。')
        definitionID = targetID(result, 'platform_definition')
        lastOperationID = result.operation_id
        link = await saveLink(req, link, {
          cloudDefinitionId: definitionID,
          lastOperationId: lastOperationID,
          lastRequestId: envelope.requestId,
          payloadDocumentId: id,
          resourceType: 'agent',
          stableKey: content.stableKey,
          syncStatus: 'local_only',
        })
      }

      if (!link) {
        throw new DeliveryEndpointError(502, 'DELIVERY_LINK_MISSING', '内容交付关联记录未能保存。')
      }
      let draftID = link.cloudDraftId ?? undefined
      let expectedRevision = 1
      let operation: CloudOperationKey = 'createOfficialDraft'
      if (draftID) {
        const current = cloudDraft(
          (
            await executeCloud(req, {
              operation: 'getOfficialDraft',
              params: { draft_id: draftID },
            })
          ).data,
        )
        if (!current || current.definition_id !== definitionID) {
          throw new DeliveryEndpointError(
            409,
            'CLOUD_DRAFT_MISMATCH',
            'Cloud 草稿与当前官方智能体不匹配。',
          )
        }
        expectedRevision = current.revision
        operation = 'updateOfficialDraft'
      }

      const draftPayload: Record<string, unknown> = {
        bundle: content.bundle,
        display_name: content.displayName,
        kind: 'initial',
        manifest: content.manifest,
      }
      if (!draftID) draftPayload.definition_id = definitionID
      const draftEnvelope = await executeCloud(req, {
        body: {
          expected_revision: expectedRevision,
          payload: draftPayload,
          reason_code: 'content_draft_sync',
        },
        operation,
        params: draftID ? { draft_id: draftID } : undefined,
      })
      const draftOperation = operationResult(draftEnvelope.data)
      if (!draftOperation) {
        throw new DeliveryEndpointError(502, 'CLOUD_RESPONSE_INVALID', 'Cloud 回执格式不合法。')
      }
      draftID = targetID(draftOperation, 'platform_draft')
      lastOperationID = draftOperation.operation_id

      const verified = cloudDraft(
        (
          await executeCloud(req, {
            operation: 'getOfficialDraft',
            params: { draft_id: draftID },
          })
        ).data,
      )
      if (
        !verified ||
        verified.definition_id !== definitionID ||
        verified.content_digest !== content.contentDigest
      ) {
        throw new DeliveryEndpointError(
          409,
          'CLOUD_DIGEST_MISMATCH',
          'Cloud 草稿摘要与后台草稿不一致。',
        )
      }

      link = await saveLink(req, link, {
        cloudDefinitionId: definitionID,
        cloudDraftId: draftID,
        cloudReleaseId: null,
        cloudSubmissionId: null,
        cloudVersionId: null,
        contentDigest: verified.content_digest,
        desktopVerification: null,
        lastErrorCode: null,
        lastErrorSummary: null,
        lastOperationId: lastOperationID,
        lastRequestId: draftEnvelope.requestId,
        payloadDocumentId: id,
        payloadRevision: verified.revision,
        resourceType: 'agent',
        runtimeManifestSha256: content.runtimeManifestSha256,
        stableKey: content.stableKey,
        syncStatus: 'draft_synced',
      })
      await auditDelivery(req, 'content-delivery.agent.sync', link, currentRequestID)
      return Response.json({ data: safeLink(link), meta: {}, requestId: currentRequestID })
    } catch (error) {
      return mapError(error, currentRequestID)
    }
  }

  const validateAgent: PayloadHandler = async (req) => {
    const currentRequestID = requestID(req)
    try {
      requireCapability(req, 'official-agents:draft:write')
      const id = routeParam(req, 'id')
      const link = await findLink(req, 'agent', id)
      if (!link?.cloudDraftId) {
        throw new DeliveryEndpointError(409, 'CLOUD_DRAFT_MISSING', '请先同步 Cloud 草稿。')
      }
      const envelope = await executeCloud(req, {
        operation: 'validateOfficialDraft',
        params: { draft_id: link.cloudDraftId },
      })
      const validation = record(envelope.data)
      if (!validation || typeof validation.valid !== 'boolean') {
        throw new DeliveryEndpointError(502, 'CLOUD_RESPONSE_INVALID', 'Cloud 校验回执格式不合法。')
      }
      const updated = await saveLink(req, link, {
        contentDigest:
          typeof validation.content_digest === 'string'
            ? validation.content_digest
            : link.contentDigest,
        lastErrorCode: validation.valid ? null : 'CLOUD_VALIDATION_FAILED',
        lastErrorSummary: validation.valid ? null : 'Cloud 内容安全或结构校验未通过。',
        lastRequestId: envelope.requestId,
        payloadRevision:
          typeof validation.draft_revision === 'number'
            ? validation.draft_revision
            : link.payloadRevision,
        syncStatus: validation.valid ? 'draft_synced' : 'validation_failed',
      })
      await auditDelivery(req, 'content-delivery.agent.validate', updated, currentRequestID)
      return Response.json({ data: safeLink(updated), meta: {}, requestId: currentRequestID })
    } catch (error) {
      return mapError(error, currentRequestID)
    }
  }

  const submitAgent: PayloadHandler = async (req) => {
    const currentRequestID = requestID(req)
    try {
      requireCapability(req, 'official-agents:draft:write')
      const id = routeParam(req, 'id')
      const link = await findLink(req, 'agent', id)
      if (!link?.cloudDraftId) {
        throw new DeliveryEndpointError(409, 'CLOUD_DRAFT_MISSING', '请先同步 Cloud 草稿。')
      }
      let body: Record<string, unknown> = {}
      try {
        body = record(typeof req.json === 'function' ? await req.json() : undefined) ?? {}
      } catch {
        body = {}
      }
      const reasonCode = typeof body.reason_code === 'string' ? body.reason_code : ''
      if (!reasonCodePattern.test(reasonCode)) {
        throw new DeliveryEndpointError(400, 'INVALID_REASON_CODE', '提交审核需要合法的原因代码。')
      }
      const validation = record(
        (
          await executeCloud(req, {
            operation: 'validateOfficialDraft',
            params: { draft_id: link.cloudDraftId },
          })
        ).data,
      )
      if (!validation?.valid || typeof validation.draft_revision !== 'number') {
        throw new DeliveryEndpointError(
          422,
          'CLOUD_VALIDATION_FAILED',
          'Cloud 校验未通过，不能提交审核。',
        )
      }
      const envelope = await executeCloud(req, {
        body: {
          expected_revision: validation.draft_revision,
          payload: {},
          reason_code: reasonCode,
        },
        operation: 'submitOfficialDraft',
        params: { draft_id: link.cloudDraftId },
      })
      const result = operationResult(envelope.data)
      if (!result)
        throw new DeliveryEndpointError(502, 'CLOUD_RESPONSE_INVALID', 'Cloud 回执格式不合法。')
      const submissionID = targetID(result, 'platform_submission')
      const updated = await saveLink(req, link, {
        cloudSubmissionId: submissionID,
        lastErrorCode: null,
        lastErrorSummary: null,
        lastOperationId: result.operation_id,
        lastRequestId: envelope.requestId,
        payloadRevision: validation.draft_revision,
        syncStatus: 'submitted',
      })
      await auditDelivery(req, 'content-delivery.agent.submit', updated, currentRequestID)
      return Response.json({ data: safeLink(updated), meta: {}, requestId: currentRequestID })
    } catch (error) {
      return mapError(error, currentRequestID)
    }
  }

  const readStatus: PayloadHandler = async (req) => {
    const currentRequestID = requestID(req)
    try {
      const resourceType = routeParam(req, 'resourceType')
      const id = routeParam(req, 'id')
      if (
        !['agent', 'category', 'skill', 'plugin'].includes(resourceType) ||
        !resourceIDPattern.test(id)
      ) {
        throw new DeliveryEndpointError(400, 'INVALID_RESOURCE', '内容资源参数不合法。')
      }
      requireCapability(
        req,
        resourceType === 'agent' ? 'official-agents:read' : 'content:publish:read',
      )
      const link = await findLink(req, resourceType, id)
      if (!link)
        throw new DeliveryEndpointError(404, 'DELIVERY_LINK_NOT_FOUND', '尚无内容交付记录。')
      let current = link
      if (
        resourceType === 'agent' &&
        typeof current.cloudDefinitionId === 'string' &&
        typeof current.cloudSubmissionId === 'string' &&
        typeof current.contentDigest === 'string' &&
        (!current.cloudReleaseId || !current.cloudVersionId)
      ) {
        current = await reconcileReleasedAgentLink(req, current, executeCloud)
      }
      if (
        resourceType === 'agent' &&
        typeof current.cloudReleaseId === 'string' &&
        typeof current.cloudVersionId === 'string' &&
        typeof current.contentDigest === 'string'
      ) {
        const envelope = await executeCloud(req, {
          operation: 'getOfficialDeliveryVerificationSummary',
          params: { release_id: current.cloudReleaseId },
        })
        const verification = deliveryVerificationForLink(
          {
            cloudDefinitionId: current.cloudDefinitionId,
            cloudReleaseId: current.cloudReleaseId,
            cloudVersionId: current.cloudVersionId,
            contentDigest: current.contentDigest,
          },
          envelope.data,
        )
        const summary = record(envelope.data)
        if (!summary || summary.release_id !== current.cloudReleaseId || !Array.isArray(summary.stages)) {
          throw new DeliveryEndpointError(
            409,
            'CLOUD_DELIVERY_VERIFICATION_MISMATCH',
            'Cloud 交付验证与当前发布记录不匹配。',
          )
        }
        current = await saveLink(req, current, {
          desktopVerification: verification,
          lastRequestId: envelope.requestId,
          syncStatus: verification.syncStatus,
        })
      }
      return Response.json({ data: safeLink(current), meta: {}, requestId: currentRequestID })
    } catch (error) {
      return mapError(error, currentRequestID)
    }
  }

  return [
    { handler: syncAgent, method: 'post', path: '/content-delivery/sync-agent/:id' },
    { handler: validateAgent, method: 'post', path: '/content-delivery/validate/:id' },
    { handler: submitAgent, method: 'post', path: '/content-delivery/submit/:id' },
    { handler: readStatus, method: 'get', path: '/content-delivery/:resourceType/:id' },
  ]
}

export const contentDeliveryEndpoints = createContentDeliveryEndpoints()
