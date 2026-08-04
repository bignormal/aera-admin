import { randomUUID } from 'node:crypto'
import { sql } from '@payloadcms/db-sqlite'
import type { JsonObject, JsonValue, Payload, PayloadRequest } from 'payload'

import { type AdminRole, type Capability, isAdminRole } from '../../access/capabilities'
import { appendAuditLog } from '../../domain/audit'
import { PlatformAPIError } from '../client'
import { type CloudUpstreamRequest, requestCloudUpstream } from './client'

export type PendingCloudOperationReceipt = {
  actorAdminId: string
  actorRole: string
  capability: string
  localActorId: string
  localActorRole: string
  operationId: string
  operationKey: string
  request: {
    actor: JsonObject | null
    body: JsonValue
    idempotencyKey: string
    method: string
    path: string
    query: string
    requestId: string
  }
  requestId: string
  rollbackRequestId?: string
}

export type CloudOperationReceiptResult = {
  administrativeRevision?: number
  auditCompletedAt?: string
  cloudStatus: 'conflict' | 'executing' | 'failed' | 'queued' | 'succeeded'
  cloudUpdatedAt: string
  errorCode?: string
  lastErrorCode?: string
  operationId: string
  rollbackCompletedAt?: string
  status: 'conflict' | 'failed' | 'reconciling' | 'succeeded'
  upstreamRequestId?: string
}

export async function persistPendingCloudOperationReceipt(
  req: PayloadRequest,
  receipt: PendingCloudOperationReceipt,
): Promise<void> {
  await req.payload.create({
    collection: 'cloud-operation-receipts',
    data: {
      ...receipt,
      attemptCount: 0,
      definitiveFailure: false,
      status: 'pending',
    },
    overrideAccess: true,
    req,
  })
}

export async function recordCloudOperationReceiptResult(
  req: PayloadRequest,
  result: CloudOperationReceiptResult,
): Promise<void> {
  await req.payload.update({
    collection: 'cloud-operation-receipts',
    data: {
      administrativeRevision: result.administrativeRevision,
      auditCompletedAt: result.auditCompletedAt,
      cloudStatus: result.cloudStatus,
      cloudUpdatedAt: result.cloudUpdatedAt,
      errorCode: result.errorCode,
      lastErrorCode: result.lastErrorCode,
      rollbackCompletedAt: result.rollbackCompletedAt,
      status: result.status,
      upstreamRequestId: result.upstreamRequestId,
    },
    overrideAccess: true,
    req,
    where: { operationId: { equals: result.operationId } },
  })
}

export async function recordCloudOperationReconciliationPending(
  req: PayloadRequest,
  options: {
    attemptedAt: string
    errorCode: string
    nextAttemptAt: string
    operationId: string
  },
): Promise<void> {
  await req.payload.update({
    collection: 'cloud-operation-receipts',
    data: {
      attemptCount: 1,
      lastAttemptAt: options.attemptedAt,
      lastErrorCode: options.errorCode,
      nextAttemptAt: options.nextAttemptAt,
      status: 'reconciling',
    },
    overrideAccess: true,
    req,
    where: { operationId: { equals: options.operationId } },
  })
}

export async function recordCloudOperationDefinitiveFailure(
  req: PayloadRequest,
  options: {
    auditCompleted: boolean
    errorCode: string
    operationId: string
  },
): Promise<void> {
  const now = new Date()
  await req.payload.update({
    collection: 'cloud-operation-receipts',
    data: {
      auditCompletedAt: options.auditCompleted ? now.toISOString() : undefined,
      definitiveFailure: true,
      errorCode: options.errorCode,
      lastErrorCode: options.auditCompleted ? undefined : 'LOCAL_AUDIT_PENDING',
      nextAttemptAt: options.auditCompleted
        ? undefined
        : new Date(now.getTime() + 5_000).toISOString(),
      status: options.auditCompleted ? 'failed' : 'reconciling',
    },
    overrideAccess: true,
    req,
    where: { operationId: { equals: options.operationId } },
  })
}

type ReconciliationPayload = Pick<Payload, 'create' | 'find' | 'findByID' | 'update'> &
  Partial<Pick<Payload, 'db'>>

type ReconciliationReceipt = PendingCloudOperationReceipt & {
  attemptCount?: number | null
  auditCompletedAt?: string | null
  cloudStatus?: 'conflict' | 'executing' | 'failed' | 'queued' | 'succeeded' | null
  cloudUpdatedAt?: string | null
  definitiveFailure?: boolean | null
  errorCode?: string | null
  id: number | string
  leaseExpiresAt?: string | null
  leaseOwner?: string | null
  rollbackCompletedAt?: string | null
  status: 'conflict' | 'failed' | 'pending' | 'reconciling' | 'succeeded'
  upstreamRequestId?: string | null
}

type ReconciliationUpstream = <T>(request: CloudUpstreamRequest) => Promise<{
  data: T
  upstreamRequestId?: string
}>

type CloudOperationSnapshot = {
  administrativeRevision?: number
  errorCode?: string
  operationId: string
  status: 'conflict' | 'executing' | 'failed' | 'queued' | 'succeeded'
  updatedAt: string
}

function operationSnapshot(
  value: unknown,
  operationId: string,
): CloudOperationSnapshot | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const data = value as Record<string, unknown>
  const status = data.status
  if (
    data.operation_id !== operationId ||
    (status !== 'queued' &&
      status !== 'executing' &&
      status !== 'succeeded' &&
      status !== 'failed' &&
      status !== 'conflict') ||
    typeof data.updated_at !== 'string'
  ) {
    return undefined
  }
  return {
    administrativeRevision:
      typeof data.administrative_revision === 'number' ? data.administrative_revision : undefined,
    errorCode: typeof data.error_code === 'string' ? data.error_code : undefined,
    operationId,
    status,
    updatedAt: data.updated_at,
  }
}

function receiptRequest(receipt: ReconciliationReceipt): CloudUpstreamRequest | undefined {
  const request = receipt.request
  if (
    !request ||
    request.idempotencyKey !== receipt.operationId ||
    request.requestId !== receipt.requestId ||
    (request.method !== 'PATCH' && request.method !== 'POST') ||
    typeof request.path !== 'string' ||
    !request.path.startsWith('/') ||
    request.path.includes('..')
  ) {
    return undefined
  }
  return {
    actor: request.actor ?? undefined,
    body: request.body,
    idempotencyKey: receipt.operationId,
    method: request.method,
    path: request.path,
    query: new URLSearchParams(request.query),
    requestId: request.requestId,
  } as CloudUpstreamRequest
}

function retryDelayMilliseconds(attemptCount: number): number {
  return Math.min(5 * 60_000, 5_000 * 2 ** Math.min(Math.max(attemptCount, 0), 6))
}

async function updateReceipt(
  payload: ReconciliationPayload,
  operationId: string,
  data: Record<string, unknown>,
): Promise<void> {
  await payload.update({
    collection: 'cloud-operation-receipts',
    data,
    overrideAccess: true,
    where: { operationId: { equals: operationId } },
  } as never)
}

async function appendReceiptAuditOnce(
  payload: ReconciliationPayload,
  receipt: ReconciliationReceipt,
  snapshot: CloudOperationSnapshot,
  upstreamRequestId?: string,
): Promise<boolean> {
  if (!isAdminRole(receipt.localActorRole)) return false
  const req = {
    headers: new Headers(),
    payload,
    user: { id: receipt.localActorId, role: receipt.localActorRole as AdminRole },
  } as unknown as PayloadRequest
  try {
    await appendAuditLog(req, {
      action: `cloud.${receipt.operationKey}`,
      after: receipt.request.body,
      capability: receipt.capability as Capability,
      errorCode: snapshot.errorCode,
      operationId: receipt.operationId,
      outcome: snapshot.status === 'succeeded' ? 'succeeded' : 'failed',
      requestId: receipt.requestId,
      resourceType: 'aera-cloud',
      upstreamRequestId,
    })
    return true
  } catch {
    try {
      const existing = (await payload.find({
        collection: 'audit-logs',
        limit: 1,
        overrideAccess: true,
        where: { operationId: { equals: receipt.operationId } },
      } as never)) as unknown as { docs: unknown[] }
      return existing.docs.length > 0
    } catch {
      return false
    }
  }
}

async function finishRollbackOnce(
  payload: ReconciliationPayload,
  receipt: ReconciliationReceipt,
  now: Date,
): Promise<boolean> {
  if (!receipt.rollbackRequestId) return true
  try {
    const rollback = (await payload.findByID({
      collection: 'official-rollback-requests',
      depth: 0,
      id: receipt.rollbackRequestId,
      overrideAccess: true,
    } as never)) as { operationId?: unknown; status?: unknown }
    if (rollback.status === 'executed') return rollback.operationId === receipt.operationId
    if (rollback.status !== 'approved') return false
    const req = {
      headers: new Headers(),
      payload,
      user: { id: receipt.localActorId, role: receipt.localActorRole },
    } as unknown as PayloadRequest
    await payload.update({
      collection: 'official-rollback-requests',
      data: {
        executedAt: now.toISOString(),
        operationId: receipt.operationId,
        status: 'executed',
      },
      id: receipt.rollbackRequestId,
      overrideAccess: true,
      req,
    } as never)
    return true
  } catch {
    return false
  }
}

async function scheduleReceiptRetry(
  payload: ReconciliationPayload,
  receipt: ReconciliationReceipt,
  now: Date,
  errorCode: string,
): Promise<void> {
  const attemptCount = (receipt.attemptCount ?? 0) + 1
  await updateReceipt(payload, receipt.operationId, {
    attemptCount,
    lastAttemptAt: now.toISOString(),
    lastErrorCode: errorCode,
    leaseExpiresAt: null,
    leaseOwner: null,
    nextAttemptAt: new Date(now.getTime() + retryDelayMilliseconds(attemptCount)).toISOString(),
    status: 'reconciling',
  })
}

async function claimReceipt(
  payload: ReconciliationPayload,
  receipt: ReconciliationReceipt,
  ownerId: string,
  now: Date,
): Promise<boolean> {
  const leaseExpiresAt = new Date(now.getTime() + 30_000).toISOString()
  if (payload.db?.drizzle) {
    const claimed = await payload.db.drizzle.run(sql`
      UPDATE \`cloud_operation_receipts\`
      SET
        \`lease_owner\` = ${ownerId},
        \`lease_expires_at\` = ${leaseExpiresAt},
        \`updated_at\` = ${now.toISOString()}
      WHERE \`operation_id\` = ${receipt.operationId}
        AND \`status\` IN ('pending', 'reconciling')
        AND (
          \`lease_expires_at\` IS NULL
          OR \`lease_expires_at\` <= ${now.toISOString()}
          OR \`lease_owner\` = ${ownerId}
        )
      RETURNING \`id\`;
    `)
    return claimed.rows.length === 1
  }
  const claimed = (await payload.update({
    collection: 'cloud-operation-receipts',
    data: {
      leaseExpiresAt,
      leaseOwner: ownerId,
    },
    overrideAccess: true,
    where: {
      and: [
        { operationId: { equals: receipt.operationId } },
        { status: { in: ['pending', 'reconciling'] } },
        {
          or: [
            { leaseExpiresAt: { exists: false } },
            { leaseExpiresAt: { less_than_equal: now.toISOString() } },
            { leaseOwner: { equals: ownerId } },
          ],
        },
      ],
    },
  } as never)) as { docs?: unknown[] }
  return (claimed.docs?.length ?? 0) === 1
}

async function finishReceipt(
  payload: ReconciliationPayload,
  receipt: ReconciliationReceipt,
  snapshot: CloudOperationSnapshot,
  upstreamRequestId: string | undefined,
  now: Date,
): Promise<void> {
  if (snapshot.status === 'queued' || snapshot.status === 'executing') {
    await scheduleReceiptRetry(payload, receipt, now, 'CLOUD_OPERATION_PENDING')
    return
  }
  const rollbackCompleted =
    snapshot.status !== 'succeeded' || (await finishRollbackOnce(payload, receipt, now))
  const auditCompleted = await appendReceiptAuditOnce(payload, receipt, snapshot, upstreamRequestId)
  const completedAt = now.toISOString()
  await updateReceipt(payload, receipt.operationId, {
    administrativeRevision: snapshot.administrativeRevision,
    auditCompletedAt: auditCompleted ? completedAt : undefined,
    cloudStatus: snapshot.status,
    cloudUpdatedAt: snapshot.updatedAt,
    errorCode: snapshot.errorCode,
    lastErrorCode: !rollbackCompleted
      ? 'LOCAL_ROLLBACK_PENDING'
      : auditCompleted
        ? null
        : 'LOCAL_AUDIT_PENDING',
    leaseExpiresAt: null,
    leaseOwner: null,
    nextAttemptAt:
      rollbackCompleted && auditCompleted
        ? null
        : new Date(now.getTime() + retryDelayMilliseconds(receipt.attemptCount ?? 0)).toISOString(),
    rollbackCompletedAt: rollbackCompleted ? completedAt : undefined,
    status: rollbackCompleted && auditCompleted ? snapshot.status : 'reconciling',
    upstreamRequestId,
  })
}

export async function reconcileCloudOperationReceipts(options: {
  clock?: () => Date
  ownerId: string
  payload: ReconciliationPayload
  upstream?: ReconciliationUpstream
}): Promise<number> {
  const clock = options.clock ?? (() => new Date())
  const upstream = options.upstream
  if (!upstream) return 0
  const now = clock()
  const page = (await options.payload.find({
    collection: 'cloud-operation-receipts',
    limit: 25,
    overrideAccess: true,
    sort: 'nextAttemptAt',
    where: {
      and: [
        { status: { in: ['pending', 'reconciling'] } },
        {
          or: [
            { nextAttemptAt: { exists: false } },
            { nextAttemptAt: { less_than_equal: now.toISOString() } },
          ],
        },
      ],
    },
  } as never)) as unknown as { docs: ReconciliationReceipt[] }

  let processed = 0
  for (const receipt of page.docs) {
    if (!(await claimReceipt(options.payload, receipt, options.ownerId, now))) continue
    processed += 1
    if (receipt.definitiveFailure) {
      await finishReceipt(
        options.payload,
        receipt,
        {
          errorCode: receipt.errorCode ?? undefined,
          operationId: receipt.operationId,
          status: 'failed',
          updatedAt: receipt.cloudUpdatedAt ?? now.toISOString(),
        },
        receipt.upstreamRequestId ?? undefined,
        now,
      )
      continue
    }
    try {
      const result = await upstream({
        method: 'GET',
        path: `/operations/${receipt.operationId}`,
        requestId: receipt.requestId,
      })
      const snapshot = operationSnapshot(result.data, receipt.operationId)
      if (!snapshot) {
        await scheduleReceiptRetry(options.payload, receipt, now, 'UPSTREAM_INVALID_RESPONSE')
        continue
      }
      await finishReceipt(options.payload, receipt, snapshot, result.upstreamRequestId, now)
    } catch (error) {
      const storedRequest = receiptRequest(receipt)
      const cloudProvedAbsent =
        error instanceof PlatformAPIError &&
        error.status === 404 &&
        error.code === 'OPERATION_NOT_FOUND'
      if (cloudProvedAbsent && storedRequest) {
        try {
          const result = await upstream(storedRequest)
          const snapshot = operationSnapshot(result.data, receipt.operationId)
          if (!snapshot) {
            await scheduleReceiptRetry(options.payload, receipt, now, 'UPSTREAM_INVALID_RESPONSE')
            continue
          }
          await finishReceipt(options.payload, receipt, snapshot, result.upstreamRequestId, now)
        } catch {
          await scheduleReceiptRetry(
            options.payload,
            receipt,
            now,
            'CLOUD_OPERATION_REPLAY_UNCERTAIN',
          )
        }
      } else if (!storedRequest) {
        await scheduleReceiptRetry(options.payload, receipt, now, 'LOCAL_RECEIPT_INVALID')
      } else {
        await scheduleReceiptRetry(options.payload, receipt, now, 'CLOUD_OPERATION_QUERY_FAILED')
      }
    }
  }
  return processed
}

export type CloudOperationReconciliationLoop = {
  runNow: () => Promise<void>
  stop: () => void
}

export function startCloudOperationReconciliation(options: {
  intervalMs?: number
  ownerId?: string
  payload: ReconciliationPayload
  upstream?: ReconciliationUpstream
}): CloudOperationReconciliationLoop {
  const intervalMs = options.intervalMs ?? 15_000
  const ownerId = options.ownerId ?? randomUUID()
  const upstream = options.upstream ?? requestCloudUpstream
  let running = false
  let stopped = false

  const runNow = async (): Promise<void> => {
    if (running || stopped) return
    running = true
    try {
      await reconcileCloudOperationReceipts({
        ownerId,
        payload: options.payload,
        upstream,
      })
    } catch {
      // A later interval retries from the durable SQLite receipts.
    } finally {
      running = false
    }
  }

  const timer = setInterval(() => void runNow(), intervalMs)
  timer.unref?.()
  void runNow()

  return {
    runNow,
    stop: () => {
      stopped = true
      clearInterval(timer)
    },
  }
}
