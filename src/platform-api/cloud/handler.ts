import { randomUUID } from 'node:crypto'
import type { PayloadHandler, PayloadRequest } from 'payload'

import { hasCapability } from '../../access/capabilities'
import { type CloudAdminIdentity, cloudIdentityFromRequest } from '../../access/cloud-actor'
import { appendAuditLog } from '../../domain/audit'
import { assertRecentStepUp } from '../../security/step-up'
import { PlatformAPIError } from '../client'
import { redactExternalData } from '../redaction'
import type { PlatformFailure, PlatformSuccess } from '../types'
import { type CloudUpstreamRequest, requestCloudUpstream } from './client'
import { type CloudOperation, cloudOperations, isCloudOperationKey } from './operations'
import {
  persistPendingCloudOperationReceipt,
  recordCloudOperationDefinitiveFailure,
  recordCloudOperationReconciliationPending,
  recordCloudOperationReceiptResult,
} from './receipts'
import type { CloudActorContext } from './token'

type CloudUpstreamRequester = <T>(request: CloudUpstreamRequest) => Promise<{
  data: T
  upstreamRequestId?: string
}>

const validRequestID = /^[A-Za-z0-9._:-]{1,128}$/
const validIdempotencyKey = /^[A-Za-z0-9._:-]{1,128}$/
const validPathParam = /^[A-Za-z0-9-]{1,64}$/
const reasonCodePattern = /^[a-z][a-z0-9_]{2,63}$/
const cloudResourceType = 'aera-cloud'

function requestID(req: PayloadRequest): string {
  const supplied = req.headers?.get('x-request-id')?.trim()
  return supplied && validRequestID.test(supplied) ? supplied : randomUUID()
}

function failure(requestId: string, status: number, code: string, message: string): Response {
  const body: PlatformFailure = { error: { code, message }, requestId }
  return Response.json(body, { status })
}

function requestOperation(req: PayloadRequest): string {
  const value = req.routeParams?.operation
  return typeof value === 'string' ? value : ''
}

function requestMethod(req: PayloadRequest): string {
  return typeof req.method === 'string' ? req.method.toUpperCase() : ''
}

async function requestBody(req: PayloadRequest): Promise<unknown> {
  if (typeof req.json !== 'function') return undefined
  try {
    return await req.json()
  } catch {
    return undefined
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function optionalText(value: unknown, maxLength: number): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string' || value.length > maxLength) return undefined
  return value
}

function expectedRevision(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 ? value : undefined
}

type PreparedUpstream = {
  actor?: CloudActorContext
  body?: unknown
  idempotencyKey?: string
  rollbackRequestId?: number | string
}

type PreparationFailure = {
  errorCode: string
  message: string
  status: number
}

type RollbackRequestDocument = {
  approvalId?: unknown
  decidedByActorId?: unknown
  expectedRevision?: unknown
  id: number | string
  reasonCode?: unknown
  releaseId?: unknown
  requestedByActorId?: unknown
  status?: unknown
  targetReleaseRevisionId?: unknown
  targetVersionId?: unknown
  ticketReference?: unknown
}

// 按操作类别构造上游请求：
// - command：包装 admin.Command（operation_id/actor_admin_id/...），Idempotency-Key=operation_id
// - desktop-command：严格透传空体，绑定当前管理员 actor 与调用方 Idempotency-Key
// - official-mutation：包装 officialMutationEnvelope，JWT 带 operation_id
// - official-rollback：校验本地双人审批记录后附加 approval_id/requester_admin_id
async function prepareUpstream(
  req: PayloadRequest,
  operation: CloudOperation,
  identity: CloudAdminIdentity,
  params: Record<string, string>,
  clientBody: unknown,
  currentRequestID: string,
): Promise<PreparedUpstream | PreparationFailure> {
  switch (operation.kind) {
    case 'read':
    case 'desktop-read':
      return { body: operation.method === 'GET' ? undefined : clientBody }
    case 'desktop-command': {
      const body = asRecord(clientBody)
      const idempotencyKey = req.headers?.get('idempotency-key')?.trim() || ''
      if (!body || Object.keys(body).length !== 0 || !validIdempotencyKey.test(idempotencyKey)) {
        return {
          errorCode: 'INVALID_DESKTOP_HEALTH_CHECK',
          message: '桌面健康检查需要空请求体与合法的 Idempotency-Key。',
          status: 400,
        }
      }
      return {
        actor: { adminId: identity.adminUUID, role: identity.cloudRole },
        body: {},
        idempotencyKey,
      }
    }
    case 'official-read':
    case 'official-validate':
      return { actor: { adminId: identity.adminUUID, role: identity.cloudRole } }
    case 'command': {
      const body = asRecord(clientBody)
      const reasonCode = typeof body?.reason_code === 'string' ? body.reason_code : ''
      const revision = expectedRevision(body?.expected_revision)
      if (!body || !reasonCodePattern.test(reasonCode) || revision === undefined) {
        return {
          errorCode: 'INVALID_COMMAND',
          message: '命令需要合法的 reason_code 与 expected_revision。',
          status: 400,
        }
      }
      const operationId = randomUUID()
      const command: Record<string, unknown> = {
        actor_admin_id: identity.adminUUID,
        expected_revision: revision,
        operation_id: operationId,
        reason_code: reasonCode,
        request_id: currentRequestID,
      }
      const ticket = optionalText(body.ticket_reference, 128)
      const note = optionalText(body.note, 500)
      if (ticket) command.ticket_reference = ticket
      if (note) command.note = note
      // disable/enable 上游要求 approval_id 非空；本批以生成的 UUID 记录审批凭据，
      // 与审计日志中的操作事件一一对应。
      if (operation.requiresApproval) command.approval_id = randomUUID()
      return { body: command, idempotencyKey: operationId }
    }
    case 'official-mutation': {
      const body = asRecord(clientBody)
      const reasonCode = typeof body?.reason_code === 'string' ? body.reason_code : ''
      const revision = expectedRevision(body?.expected_revision)
      if (!body || !reasonCodePattern.test(reasonCode) || revision === undefined) {
        return {
          errorCode: 'INVALID_COMMAND',
          message: '官方 Agent 操作需要合法的 reason_code 与 expected_revision。',
          status: 400,
        }
      }
      const operationId = randomUUID()
      const envelope: Record<string, unknown> = {
        actor_admin_id: identity.adminUUID,
        actor_admin_role: identity.cloudRole,
        expected_revision: revision,
        operation_id: operationId,
        payload: body.payload ?? {},
        reason_code: reasonCode,
      }
      const ticket = optionalText(body.ticket_reference, 128)
      if (ticket) envelope.ticket_reference = ticket
      return {
        actor: {
          adminId: identity.adminUUID,
          operationId,
          role: identity.cloudRole,
        },
        body: envelope,
        idempotencyKey: operationId,
      }
    }
    case 'official-rollback': {
      const body = asRecord(clientBody)
      const approvalRequestId = body?.approval_request_id
      if (typeof approvalRequestId !== 'number' && typeof approvalRequestId !== 'string') {
        return {
          errorCode: 'INVALID_COMMAND',
          message: '回滚执行需要 approval_request_id。',
          status: 400,
        }
      }
      let doc: RollbackRequestDocument
      try {
        doc = (await req.payload.findByID({
          collection: 'official-rollback-requests',
          depth: 0,
          id: approvalRequestId,
          overrideAccess: true,
        })) as RollbackRequestDocument
      } catch {
        return {
          errorCode: 'APPROVAL_NOT_FOUND',
          message: '回滚审批记录不存在。',
          status: 404,
        }
      }
      if (doc.status !== 'approved') {
        return {
          errorCode: 'APPROVAL_NOT_READY',
          message: '回滚审批尚未批准或已被使用。',
          status: 409,
        }
      }
      if (doc.decidedByActorId !== identity.adminUUID) {
        return {
          errorCode: 'APPROVAL_EXECUTOR_MISMATCH',
          message: '仅回滚审批的批准人可以执行回滚。',
          status: 403,
        }
      }
      if (doc.requestedByActorId === identity.adminUUID) {
        return {
          errorCode: 'APPROVAL_SELF_EXECUTION',
          message: '回滚发起人与执行人必须是不同管理员。',
          status: 403,
        }
      }
      if (doc.releaseId !== params.release_id) {
        return {
          errorCode: 'APPROVAL_RELEASE_MISMATCH',
          message: '审批记录与目标发布不匹配。',
          status: 409,
        }
      }
      const approvalId = typeof doc.approvalId === 'string' ? doc.approvalId : ''
      const requesterActorId =
        typeof doc.requestedByActorId === 'string' ? doc.requestedByActorId : ''
      const reasonCode = typeof doc.reasonCode === 'string' ? doc.reasonCode : ''
      const revision = expectedRevision(doc.expectedRevision)
      if (!approvalId || !requesterActorId || !reasonCodePattern.test(reasonCode) || !revision) {
        return {
          errorCode: 'APPROVAL_INVALID',
          message: '回滚审批记录数据不完整。',
          status: 409,
        }
      }
      const operationId = randomUUID()
      const envelope: Record<string, unknown> = {
        actor_admin_id: identity.adminUUID,
        actor_admin_role: identity.cloudRole,
        approval_id: approvalId,
        expected_revision: revision,
        operation_id: operationId,
        payload: {
          target_release_revision_id: doc.targetReleaseRevisionId,
          target_version_id: doc.targetVersionId,
        },
        reason_code: reasonCode,
        requester_admin_id: requesterActorId,
      }
      const ticket = optionalText(doc.ticketReference, 128)
      if (ticket) envelope.ticket_reference = ticket
      return {
        actor: {
          adminId: identity.adminUUID,
          approvalId,
          operationId,
          requesterAdminId: requesterActorId,
          role: identity.cloudRole,
        },
        body: envelope,
        idempotencyKey: operationId,
        rollbackRequestId: doc.id,
      }
    }
    default:
      return { errorCode: 'OPERATION_NOT_FOUND', message: '未知操作类别。', status: 404 }
  }
}

function isPreparationFailure(
  value: PreparedUpstream | PreparationFailure,
): value is PreparationFailure {
  return typeof (value as PreparationFailure).errorCode === 'string'
}

function isAmbiguousMutationError(error: unknown): boolean {
  return (
    error instanceof PlatformAPIError &&
    (error.code === 'UPSTREAM_ABORTED' ||
      error.code === 'UPSTREAM_NETWORK_ERROR' ||
      error.code === 'UPSTREAM_TIMEOUT' ||
      error.status === 409 ||
      error.status >= 500)
  )
}

async function markRollbackExecuted(
  req: PayloadRequest,
  rollbackRequestId: number | string,
  operationId: string | undefined,
): Promise<boolean> {
  try {
    await req.payload.update({
      collection: 'official-rollback-requests',
      data: {
        executedAt: new Date().toISOString(),
        operationId,
        status: 'executed',
      },
      id: rollbackRequestId,
      overrideAccess: true,
      req,
    })
    return true
  } catch {
    return false
  }
}

async function auditCloudMutation(
  req: PayloadRequest,
  options: {
    after?: unknown
    capability: CloudOperation['capability']
    errorCode?: string
    operation: string
    operationId: string
    outcome: 'failed' | 'succeeded'
    params: Record<string, string>
    requestId: string
    upstreamRequestId?: string
  },
): Promise<boolean> {
  try {
    await appendAuditLog(req, {
      action: `cloud.${options.operation}`,
      after: options.after,
      capability: options.capability,
      errorCode: options.errorCode,
      outcome: options.outcome,
      operationId: options.operationId,
      requestId: options.requestId,
      resourceId: Object.values(options.params)[0],
      resourceType: cloudResourceType,
      upstreamRequestId: options.upstreamRequestId,
    })
    return true
  } catch {
    try {
      const existing = await req.payload.find({
        collection: 'audit-logs',
        limit: 1,
        overrideAccess: true,
        where: { operationId: { equals: options.operationId } },
      })
      return existing.docs.length > 0
    } catch {
      return false
    }
  }
}

export function createCloudHandler(
  upstream: CloudUpstreamRequester = requestCloudUpstream,
): PayloadHandler {
  return async (req) => {
    const currentRequestID = requestID(req)
    if (!req.user) {
      return failure(currentRequestID, 401, 'UNAUTHENTICATED', '请先登录管理后台。')
    }

    const operationKey = requestOperation(req)
    if (!isCloudOperationKey(operationKey)) {
      return failure(currentRequestID, 404, 'OPERATION_NOT_FOUND', '未找到该云端管理操作。')
    }
    const operation = cloudOperations[operationKey]
    const durableMutation = operation.mutation && operation.kind !== 'desktop-command'
    if (!hasCapability(req.user.role, operation.capability)) {
      return failure(currentRequestID, 403, 'FORBIDDEN', '当前角色无权执行该操作。')
    }
    if (requestMethod(req) !== operation.method) {
      return failure(currentRequestID, 405, 'METHOD_NOT_ALLOWED', '请求方法与已注册操作不匹配。')
    }
    const identity = await cloudIdentityFromRequest(req)
    if (!identity) {
      return failure(
        currentRequestID,
        409,
        'CLOUD_ACTOR_MISSING',
        '当前管理员还没有云 actor 标识，请重新登录后重试。',
      )
    }
    if (operation.requiredActorRole && identity.cloudRole !== operation.requiredActorRole) {
      return failure(
        currentRequestID,
        403,
        'ACTOR_DUTY_MISMATCH',
        '当前管理员职责与云端操作不匹配。',
      )
    }

    if (operation.requiresReauthentication) {
      const stepUp = await assertRecentStepUp(req)
      if (!stepUp.ok) {
        const message =
          stepUp.errorCode === 'TOTP_NOT_ENROLLED'
            ? '该高风险操作需要先绑定 TOTP 动态口令。'
            : '该高风险操作需要重新完成 TOTP 二次验证。'
        return failure(currentRequestID, 428, stepUp.errorCode, message)
      }
    }

    const url = new URL(req.url || 'http://localhost')
    const params: Record<string, string> = {}
    for (const name of operation.params || []) {
      const value = url.searchParams.get(name)?.trim() || ''
      if (!validPathParam.test(value)) {
        return failure(currentRequestID, 400, 'INVALID_PATH_PARAMETER', `参数 ${name} 不合法。`)
      }
      params[name] = value
      url.searchParams.delete(name)
    }

    const clientBody =
      operation.kind === 'official-validate' || operation.method === 'GET'
        ? undefined
        : await requestBody(req)
    const prepared = await prepareUpstream(
      req,
      operation,
      identity,
      params,
      clientBody,
      currentRequestID,
    )
    if (isPreparationFailure(prepared)) {
      return failure(currentRequestID, prepared.status, prepared.errorCode, prepared.message)
    }

    if (durableMutation && prepared.idempotencyKey) {
      try {
        await persistPendingCloudOperationReceipt(req, {
          actorAdminId: identity.adminUUID,
          actorRole: identity.cloudRole,
          capability: operation.capability,
          localActorId: String(req.user.id),
          localActorRole: req.user.role,
          operationId: prepared.idempotencyKey,
          operationKey,
          request: {
            actor: prepared.actor ?? null,
            body: prepared.body,
            idempotencyKey: prepared.idempotencyKey,
            method: operation.method,
            path: operation.upstreamPath(params),
            query: url.searchParams.toString(),
            requestId: currentRequestID,
          },
          requestId: currentRequestID,
          rollbackRequestId:
            prepared.rollbackRequestId === undefined
              ? undefined
              : String(prepared.rollbackRequestId),
        })
      } catch {
        return failure(
          currentRequestID,
          503,
          'LOCAL_OPERATION_RECEIPT_UNAVAILABLE',
          '本地操作记录暂时不可用，未向 Aera Cloud 提交变更。',
        )
      }
    }

    try {
      let result: Awaited<ReturnType<CloudUpstreamRequester>>
      try {
        result = await upstream({
          actor: prepared.actor,
          body: prepared.body,
          idempotencyKey: prepared.idempotencyKey,
          method: operation.method,
          path: operation.upstreamPath(params),
          query: url.searchParams,
          requiredScope: operation.upstreamScope,
          requestId: currentRequestID,
          signal: req.signal,
        })
      } catch (error) {
        if (!durableMutation || !prepared.idempotencyKey || !isAmbiguousMutationError(error)) {
          throw error
        }
        try {
          result = await upstream({
            method: 'GET',
            path: `/operations/${prepared.idempotencyKey}`,
            requestId: currentRequestID,
          })
        } catch (reconciliationError) {
          const attemptedAt = new Date()
          const errorCode =
            reconciliationError instanceof PlatformAPIError
              ? reconciliationError.code
              : 'UPSTREAM_UNEXPECTED_ERROR'
          try {
            await recordCloudOperationReconciliationPending(req, {
              attemptedAt: attemptedAt.toISOString(),
              errorCode,
              nextAttemptAt: new Date(attemptedAt.getTime() + 5_000).toISOString(),
              operationId: prepared.idempotencyKey,
            })
          } catch {
            // The original pending receipt remains durable and will be recovered on restart.
          }
          const pending: PlatformSuccess<
            { operation_id: string; status: 'queued'; updated_at: string },
            Record<string, never>
          > = {
            data: {
              operation_id: prepared.idempotencyKey,
              status: 'queued',
              updated_at: attemptedAt.toISOString(),
            },
            meta: {},
            requestId: currentRequestID,
          }
          return Response.json(pending, { status: 202 })
        }
      }
      if (durableMutation && prepared.idempotencyKey) {
        const operationResult = asRecord(result.data)
        const operationId = operationResult?.operation_id
        const cloudStatus = operationResult?.status
        const cloudUpdatedAt = operationResult?.updated_at
        const validCloudStatus =
          cloudStatus === 'queued' ||
          cloudStatus === 'executing' ||
          cloudStatus === 'succeeded' ||
          cloudStatus === 'failed' ||
          cloudStatus === 'conflict'
        if (
          operationResult &&
          operationId === prepared.idempotencyKey &&
          validCloudStatus &&
          typeof cloudUpdatedAt === 'string'
        ) {
          const terminal =
            cloudStatus === 'succeeded' || cloudStatus === 'failed' || cloudStatus === 'conflict'
          const rollbackCompleted =
            cloudStatus !== 'succeeded' ||
            operation.kind !== 'official-rollback' ||
            prepared.rollbackRequestId === undefined ||
            (await markRollbackExecuted(req, prepared.rollbackRequestId, operationId))
          const auditCompleted =
            !terminal ||
            (await auditCloudMutation(req, {
              after: prepared.body,
              capability: operation.capability,
              errorCode:
                typeof operationResult.error_code === 'string'
                  ? operationResult.error_code
                  : undefined,
              operation: operationKey,
              operationId,
              outcome: cloudStatus === 'succeeded' ? 'succeeded' : 'failed',
              params,
              requestId: currentRequestID,
              upstreamRequestId: result.upstreamRequestId,
            }))
          const localComplete = terminal && rollbackCompleted && auditCompleted
          const completedAt = new Date().toISOString()
          try {
            await recordCloudOperationReceiptResult(req, {
              administrativeRevision:
                typeof operationResult.administrative_revision === 'number'
                  ? operationResult.administrative_revision
                  : undefined,
              auditCompletedAt: auditCompleted && terminal ? completedAt : undefined,
              cloudStatus,
              cloudUpdatedAt,
              errorCode:
                typeof operationResult.error_code === 'string'
                  ? operationResult.error_code
                  : undefined,
              lastErrorCode: !rollbackCompleted
                ? 'LOCAL_ROLLBACK_PENDING'
                : !auditCompleted
                  ? 'LOCAL_AUDIT_PENDING'
                  : undefined,
              operationId,
              rollbackCompletedAt: rollbackCompleted && terminal ? completedAt : undefined,
              status: localComplete ? cloudStatus : 'reconciling',
              upstreamRequestId: result.upstreamRequestId,
            })
          } catch {
            // The original pending receipt remains durable; the process loop
            // will query Cloud and finish local side effects without replaying.
          }
        }
      }
      const response: PlatformSuccess<unknown, { upstreamRequestId?: string }> = {
        data: redactExternalData(result.data),
        meta: result.upstreamRequestId ? { upstreamRequestId: result.upstreamRequestId } : {},
        requestId: currentRequestID,
      }
      return Response.json(response)
    } catch (error) {
      const platformError =
        error instanceof PlatformAPIError
          ? error
          : new PlatformAPIError('UPSTREAM_UNEXPECTED_ERROR', 502, currentRequestID)
      if (durableMutation) {
        const auditCompleted = await auditCloudMutation(req, {
          after: prepared.body,
          capability: operation.capability,
          errorCode: platformError.code,
          operation: operationKey,
          operationId: prepared.idempotencyKey || currentRequestID,
          outcome: 'failed',
          params,
          requestId: currentRequestID,
          upstreamRequestId: platformError.upstreamRequestId,
        })
        if (prepared.idempotencyKey) {
          try {
            await recordCloudOperationDefinitiveFailure(req, {
              auditCompleted,
              errorCode: platformError.code,
              operationId: prepared.idempotencyKey,
            })
          } catch {
            // The pending receipt remains available for startup recovery.
          }
        }
      }
      return failure(
        currentRequestID,
        platformError.status,
        platformError.code,
        'Aera Cloud 管理服务暂时无法完成该操作。',
      )
    }
  }
}
