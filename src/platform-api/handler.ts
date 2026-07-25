import { randomUUID } from 'node:crypto'
import type { PayloadHandler, PayloadRequest } from 'payload'

import { hasCapability } from '../access/capabilities'
import { appendAuditLog } from '../domain/audit'
import { assertRecentStepUp } from '../security/step-up'
import { PlatformAPIError, requestUpstream, type UpstreamRequest } from './client'
import { isPlatformOperationKey, platformOperations } from './operations'
import { redactExternalData } from './redaction'
import type { PlatformFailure, PlatformSuccess } from './types'

type UpstreamRequester = <T>(request: UpstreamRequest) => Promise<{
  data: T
  upstreamRequestId?: string
}>

const validRequestID = /^[A-Za-z0-9._:-]{1,128}$/
const validPathParam = /^[A-Za-z0-9_-]+$/

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

async function auditMutation(
  req: PayloadRequest,
  options: {
    after?: unknown
    capability: (typeof platformOperations)[keyof typeof platformOperations]['capability']
    errorCode?: string
    operation: string
    outcome: 'failed' | 'succeeded'
    params: Record<string, string>
    requestId: string
    upstreamRequestId?: string
  },
): Promise<void> {
  try {
    await appendAuditLog(req, {
      action: `platform.${options.operation}`,
      after: options.after,
      capability: options.capability,
      errorCode: options.errorCode,
      outcome: options.outcome,
      requestId: options.requestId,
      resourceId: options.params.id,
      resourceType: 'agentera-api',
      upstreamRequestId: options.upstreamRequestId,
    })
  } catch {
    // The stable upstream result remains available if audit persistence is temporarily unavailable.
  }
}

export function createPlatformHandler(
  upstream: UpstreamRequester = requestUpstream,
): PayloadHandler {
  return async (req) => {
    const currentRequestID = requestID(req)
    if (!req.user) {
      return failure(currentRequestID, 401, 'UNAUTHENTICATED', '请先登录管理后台。')
    }

    const operationKey = requestOperation(req)
    if (!isPlatformOperationKey(operationKey)) {
      return failure(currentRequestID, 404, 'OPERATION_NOT_FOUND', '未找到该平台管理操作。')
    }
    const operation = platformOperations[operationKey]
    if (!hasCapability(req.user.role, operation.capability)) {
      return failure(currentRequestID, 403, 'FORBIDDEN', '当前角色无权执行该操作。')
    }
    if (requestMethod(req) !== operation.method) {
      return failure(currentRequestID, 405, 'METHOD_NOT_ALLOWED', '请求方法与已注册操作不匹配。')
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
    const body = operation.mutation ? await requestBody(req) : undefined

    try {
      const result = await upstream({
        body,
        idempotencyKey: req.headers?.get('idempotency-key')?.trim() || undefined,
        method: operation.method,
        path: operation.upstreamPath(params),
        query: url.searchParams,
        requestId: currentRequestID,
        signal: req.signal,
      })
      if (operation.mutation) {
        await auditMutation(req, {
          after: body,
          capability: operation.capability,
          operation: operationKey,
          outcome: 'succeeded',
          params,
          requestId: currentRequestID,
          upstreamRequestId: result.upstreamRequestId,
        })
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
      if (operation.mutation) {
        await auditMutation(req, {
          after: body,
          capability: operation.capability,
          errorCode: platformError.code,
          operation: operationKey,
          outcome: 'failed',
          params,
          requestId: currentRequestID,
          upstreamRequestId: platformError.upstreamRequestId,
        })
      }
      return failure(
        currentRequestID,
        platformError.status,
        platformError.code,
        'AgentEra API 管理服务暂时无法完成该操作。',
      )
    }
  }
}
