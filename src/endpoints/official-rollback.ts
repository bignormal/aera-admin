import { randomUUID } from 'node:crypto'
import type { Endpoint, PayloadRequest } from 'payload'

import { hasCapability } from '../access/capabilities'
import { cloudIdentityFromRequest } from '../access/cloud-actor'

// 官方 Agent 回滚双人复核流程端点：
// 发起（requested）→ 审批（approved/rejected，审批人 ≠ 发起人）→ 取消（发起人或超管）。
// 执行阶段由 /api/cloud/v1/rollbackOfficialRelease 完成并标记 executed。
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const reasonCodePattern = /^[a-z][a-z0-9_]{2,63}$/

function requestID(req: PayloadRequest): string {
  const supplied = req.headers?.get('x-request-id')?.trim()
  return supplied && /^[A-Za-z0-9._:-]{1,128}$/.test(supplied) ? supplied : randomUUID()
}

function failure(requestId: string, status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message }, requestId }, { status })
}

async function requestBody(req: PayloadRequest): Promise<Record<string, unknown>> {
  if (typeof req.json !== 'function') return {}
  try {
    const body = await req.json()
    return body && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

function docID(req: PayloadRequest): string {
  const value = req.routeParams?.id
  return typeof value === 'string' ? value : ''
}

type RollbackDocument = {
  id: number | string
  requestedBy?: unknown
  requestedByActorId?: unknown
  status?: unknown
}

export const officialRollbackEndpoints: Endpoint[] = [
  {
    path: '/official-rollback-requests/create',
    method: 'post',
    handler: async (req) => {
      const currentRequestID = requestID(req)
      if (!req.user) return failure(currentRequestID, 401, 'UNAUTHENTICATED', '请先登录管理后台。')
      if (!hasCapability(req.user.role, 'official-agents:rollback:write')) {
        return failure(currentRequestID, 403, 'FORBIDDEN', '当前角色无权发起回滚审批。')
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

      const body = await requestBody(req)
      const releaseId = typeof body.release_id === 'string' ? body.release_id : ''
      const targetVersionId =
        typeof body.target_version_id === 'string' ? body.target_version_id : ''
      const targetReleaseRevisionId =
        typeof body.target_release_revision_id === 'string' ? body.target_release_revision_id : ''
      const reasonCode = typeof body.reason_code === 'string' ? body.reason_code : ''
      const revision = body.expected_revision
      if (
        !uuidPattern.test(releaseId) ||
        !uuidPattern.test(targetVersionId) ||
        !uuidPattern.test(targetReleaseRevisionId) ||
        !reasonCodePattern.test(reasonCode) ||
        typeof revision !== 'number' ||
        !Number.isInteger(revision) ||
        revision < 1
      ) {
        return failure(currentRequestID, 400, 'INVALID_REQUEST', '回滚审批参数不完整或不合法。')
      }

      const doc = await req.payload.create({
        collection: 'official-rollback-requests',
        data: {
          expectedRevision: revision,
          reasonCode,
          releaseId,
          requestedBy: req.user.id,
          requestedByActorId: identity.adminUUID,
          status: 'requested',
          targetReleaseRevisionId,
          targetVersionId,
          ticketReference:
            typeof body.ticket_reference === 'string' && body.ticket_reference
              ? body.ticket_reference
              : undefined,
        },
        overrideAccess: true,
        req,
      })
      return Response.json({ data: doc, requestId: currentRequestID }, { status: 201 })
    },
  },
  {
    path: '/official-rollback-requests/:id/decide',
    method: 'post',
    handler: async (req) => {
      const currentRequestID = requestID(req)
      if (!req.user) return failure(currentRequestID, 401, 'UNAUTHENTICATED', '请先登录管理后台。')
      if (!hasCapability(req.user.role, 'official-agents:rollback:write')) {
        return failure(currentRequestID, 403, 'FORBIDDEN', '当前角色无权审批回滚。')
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

      const body = await requestBody(req)
      const decision = body.decision
      if (decision !== 'approve' && decision !== 'reject') {
        return failure(
          currentRequestID,
          400,
          'INVALID_REQUEST',
          'decision 必须为 approve 或 reject。',
        )
      }

      let doc: RollbackDocument
      try {
        doc = (await req.payload.findByID({
          collection: 'official-rollback-requests',
          depth: 0,
          id: docID(req),
          overrideAccess: true,
        })) as RollbackDocument
      } catch {
        return failure(currentRequestID, 404, 'APPROVAL_NOT_FOUND', '回滚审批记录不存在。')
      }
      if (doc.status !== 'requested') {
        return failure(currentRequestID, 409, 'APPROVAL_ALREADY_DECIDED', '该回滚审批已被处理。')
      }
      if (doc.requestedByActorId === identity.adminUUID) {
        return failure(
          currentRequestID,
          403,
          'APPROVAL_SELF_DECISION',
          '回滚审批需要另一名管理员复核，不能自批。',
        )
      }

      const updated = await req.payload.update({
        collection: 'official-rollback-requests',
        data: {
          decidedAt: new Date().toISOString(),
          decidedBy: req.user.id,
          decidedByActorId: identity.adminUUID,
          decisionNote:
            typeof body.note === 'string' && body.note ? body.note.slice(0, 500) : undefined,
          status: decision === 'approve' ? 'approved' : 'rejected',
        },
        id: doc.id,
        overrideAccess: true,
        req,
      })
      return Response.json({ data: updated, requestId: currentRequestID })
    },
  },
  {
    path: '/official-rollback-requests/:id/cancel',
    method: 'post',
    handler: async (req) => {
      const currentRequestID = requestID(req)
      if (!req.user) return failure(currentRequestID, 401, 'UNAUTHENTICATED', '请先登录管理后台。')
      if (!hasCapability(req.user.role, 'official-agents:rollback:write')) {
        return failure(currentRequestID, 403, 'FORBIDDEN', '当前角色无权取消回滚审批。')
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

      let doc: RollbackDocument
      try {
        doc = (await req.payload.findByID({
          collection: 'official-rollback-requests',
          depth: 0,
          id: docID(req),
          overrideAccess: true,
        })) as RollbackDocument
      } catch {
        return failure(currentRequestID, 404, 'APPROVAL_NOT_FOUND', '回滚审批记录不存在。')
      }
      if (doc.status !== 'requested' && doc.status !== 'approved') {
        return failure(currentRequestID, 409, 'APPROVAL_NOT_CANCELLABLE', '该回滚审批无法取消。')
      }
      const isRequester = doc.requestedByActorId === identity.adminUUID
      if (!isRequester && req.user.role !== 'super_admin') {
        return failure(currentRequestID, 403, 'FORBIDDEN', '仅发起人或超级管理员可以取消回滚审批。')
      }

      const updated = await req.payload.update({
        collection: 'official-rollback-requests',
        data: { status: 'cancelled' },
        id: doc.id,
        overrideAccess: true,
        req,
      })
      return Response.json({ data: updated, requestId: currentRequestID })
    },
  },
]
