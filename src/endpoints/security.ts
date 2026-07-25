import { randomUUID } from 'node:crypto'
import type { Endpoint, PayloadRequest } from 'payload'

import { hasCapability } from '../access/capabilities'
import { appendAuditLog } from '../domain/audit'
import {
  confirmTOTP,
  enrollTOTP,
  stepUpState,
  stepUpWindowSeconds,
  verifyStepUp,
} from '../security/step-up'

function requestID(req: PayloadRequest): string {
  const supplied = req.headers?.get('x-request-id')?.trim()
  return supplied && /^[A-Za-z0-9._:-]{1,128}$/.test(supplied) ? supplied : randomUUID()
}

function failure(requestId: string, status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message }, requestId }, { status })
}

const errorMessages: Record<string, { message: string; status: number }> = {
  INVALID_CODE: { message: '动态口令不正确或已过期。', status: 400 },
  TOTP_ALREADY_ENABLED: { message: 'TOTP 已绑定，如需重置请联系超级管理员。', status: 409 },
  TOTP_NOT_ENROLLED: { message: '请先完成 TOTP 绑定。', status: 409 },
  UNAUTHENTICATED: { message: '请先登录管理后台。', status: 401 },
}

function rejected(requestId: string, errorCode: string): Response {
  const mapped = errorMessages[errorCode] ?? { message: '请求被拒绝。', status: 400 }
  return failure(requestId, mapped.status, errorCode, mapped.message)
}

async function requestCode(req: PayloadRequest): Promise<string> {
  if (typeof req.json !== 'function') return ''
  try {
    const body = (await req.json()) as { code?: unknown }
    return typeof body?.code === 'string' ? body.code.trim() : ''
  } catch {
    return ''
  }
}

function targetAdminId(req: PayloadRequest): string {
  const value = req.routeParams?.adminId
  return typeof value === 'string' && /^[A-Za-z0-9_-]+$/.test(value) ? value : ''
}

async function auditSecurityEvent(
  req: PayloadRequest,
  action: string,
  outcome: 'failed' | 'succeeded',
  requestId: string,
  errorCode?: string,
): Promise<void> {
  try {
    await appendAuditLog(req, {
      action,
      capability: 'auth:session',
      errorCode,
      outcome,
      requestId,
      resourceId: req.user ? String(req.user.id) : undefined,
      resourceType: 'admins',
    })
  } catch {
    // 审计暂不可用时不阻断安全流程本身。
  }
}

export const securityEndpoints: Endpoint[] = [
  {
    path: '/security/totp/reset/:adminId',
    method: 'post',
    handler: async (req) => {
      const currentRequestID = requestID(req)
      if (!req.user) return rejected(currentRequestID, 'UNAUTHENTICATED')
      if (req.user.role !== 'super_admin' || !hasCapability(req.user.role, 'admins:write')) {
        return failure(currentRequestID, 403, 'FORBIDDEN', '当前角色无权重置管理员 TOTP。')
      }
      const adminId = targetAdminId(req)
      if (!adminId) return failure(currentRequestID, 400, 'INVALID_ADMIN_ID', '管理员 ID 不合法。')

      const doc = await req.payload.update({
        collection: 'admins',
        data: { stepUpVerifiedAt: null, totpEnabledAt: null, totpSecret: null },
        id: adminId,
        overrideAccess: true,
        req,
      })
      await appendAuditLog(req, {
        action: 'security.totp.reset',
        after: { stepUpVerifiedAt: null, totpEnabledAt: null, totpSecret: null },
        capability: 'admins:write',
        outcome: 'succeeded',
        requestId: currentRequestID,
        resourceId: adminId,
        resourceType: 'admins',
      })
      return Response.json({ data: { adminId, reset: true, updatedAt: doc.updatedAt }, requestId: currentRequestID })
    },
  },
  {
    path: '/security/totp/enroll',
    method: 'post',
    handler: async (req) => {
      const currentRequestID = requestID(req)
      if (!req.user) return rejected(currentRequestID, 'UNAUTHENTICATED')
      const result = await enrollTOTP(req)
      if (result.status === 'rejected') return rejected(currentRequestID, result.errorCode)
      await auditSecurityEvent(req, 'security.totp.enroll', 'succeeded', currentRequestID)
      return Response.json({
        data: { otpauthURL: result.otpauthURL, secret: result.secret },
        requestId: currentRequestID,
      })
    },
  },
  {
    path: '/security/totp/confirm',
    method: 'post',
    handler: async (req) => {
      const currentRequestID = requestID(req)
      if (!req.user) return rejected(currentRequestID, 'UNAUTHENTICATED')
      const result = await confirmTOTP(req, await requestCode(req))
      if (result.status === 'rejected') {
        await auditSecurityEvent(
          req,
          'security.totp.confirm',
          'failed',
          currentRequestID,
          result.errorCode,
        )
        return rejected(currentRequestID, result.errorCode)
      }
      await auditSecurityEvent(req, 'security.totp.confirm', 'succeeded', currentRequestID)
      return Response.json({
        data: { totpEnabledAt: result.totpEnabledAt },
        requestId: currentRequestID,
      })
    },
  },
  {
    path: '/security/step-up',
    method: 'post',
    handler: async (req) => {
      const currentRequestID = requestID(req)
      if (!req.user) return rejected(currentRequestID, 'UNAUTHENTICATED')
      const result = await verifyStepUp(req, await requestCode(req))
      if (result.status === 'rejected') {
        await auditSecurityEvent(
          req,
          'security.step_up',
          'failed',
          currentRequestID,
          result.errorCode,
        )
        return rejected(currentRequestID, result.errorCode)
      }
      await auditSecurityEvent(req, 'security.step_up', 'succeeded', currentRequestID)
      return Response.json({
        data: {
          expiresInSeconds: result.expiresInSeconds,
          verifiedAt: result.verifiedAt,
        },
        requestId: currentRequestID,
      })
    },
  },
  {
    path: '/security/step-up/status',
    method: 'get',
    handler: async (req) => {
      const currentRequestID = requestID(req)
      if (!req.user) return rejected(currentRequestID, 'UNAUTHENTICATED')
      const state = await stepUpState(req)
      if (!state) return rejected(currentRequestID, 'UNAUTHENTICATED')
      return Response.json({
        data: { ...state, windowSeconds: stepUpWindowSeconds },
        requestId: currentRequestID,
      })
    },
  },
]
