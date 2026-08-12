import { expect, it, vi } from 'vitest'

import { PlatformAPIError } from '../../src/platform-api/client'
import * as receiptAPI from '../../src/platform-api/cloud/receipts'
import {
  type PendingCloudOperationReceipt,
  reconcileCloudOperationReceipts,
} from '../../src/platform-api/cloud/receipts'
import { up as migrateOperationReceipts } from '../../src/migrations/20260804_034936_admin_operation_reconciliation'
import configPromise from '../../src/payload.config'
import { getTestPayload } from '../helpers/payload'

const operationId = '2c6e4a7f-3e5d-6f70-ab12-3456789abcde'

function pendingReceipt(): PendingCloudOperationReceipt & {
  attemptCount: number
  definitiveFailure: false
  id: number
  status: 'pending'
} {
  return {
    actorAdminId: '7f3e9a10-6b2c-4d8e-9f01-abcdef012345',
    actorRole: 'operator',
    attemptCount: 0,
    capability: 'cloud:sessions:write',
    definitiveFailure: false,
    id: 11,
    localActorId: '7',
    localActorRole: 'operations_admin',
    operationId,
    operationKey: 'revokeCloudSession',
    request: {
      actor: null,
      body: { operation_id: operationId },
      idempotencyKey: operationId,
      method: 'POST',
      path: '/sessions/7f3e9a10-6b2c-4d8e-9f01-abcdef012345/revoke',
      query: '',
      replayable: true,
      requestId: 'cloud-request-1',
    },
    requestId: 'cloud-request-1',
    status: 'pending',
  }
}

it('recovers a pending receipt after restart by querying Cloud before any replay', async () => {
  const receipt = pendingReceipt()
  const create = vi.fn().mockResolvedValue({ id: 90 })
  const find = vi
    .fn()
    .mockImplementation(({ collection }) =>
      Promise.resolve({ docs: collection === 'cloud-operation-receipts' ? [receipt] : [] }),
    )
  const update = vi.fn().mockResolvedValue({ docs: [receipt] })
  const upstream = vi.fn().mockResolvedValue({
    data: {
      operation_id: operationId,
      status: 'succeeded',
      updated_at: '2026-08-04T03:00:00.000Z',
    },
    upstreamRequestId: 'cloud-restart-1',
  })
  const processed = await reconcileCloudOperationReceipts({
    clock: () => new Date('2026-08-04T03:01:00.000Z'),
    ownerId: 'admin-process-a',
    payload: { create, find, findByID: vi.fn(), update },
    upstream,
  })

  expect(processed).toBe(1)
  expect(upstream).toHaveBeenCalledTimes(1)
  expect(upstream).toHaveBeenCalledWith({
    method: 'GET',
    path: `/operations/${operationId}`,
    requestId: 'cloud-request-1',
  })
  expect(create).toHaveBeenCalledTimes(1)
  expect(create).toHaveBeenCalledWith(
    expect.objectContaining({
      collection: 'audit-logs',
      data: expect.objectContaining({ operationId, outcome: 'succeeded' }),
    }),
  )
  expect(update).toHaveBeenCalledWith(
    expect.objectContaining({
      collection: 'cloud-operation-receipts',
      data: expect.objectContaining({
        auditCompletedAt: expect.any(String),
        cloudStatus: 'succeeded',
        status: 'succeeded',
      }),
      where: { operationId: { equals: operationId } },
    }),
  )
})

it('allows only one process to reconcile a receipt under a competing lease', async () => {
  const receipt = pendingReceipt()
  let leaseAvailable = true
  const create = vi.fn().mockResolvedValue({ id: 90 })
  const find = vi.fn().mockResolvedValue({ docs: [receipt] })
  const update = vi.fn().mockImplementation(({ data }) => {
    if (data.leaseOwner) {
      if (!leaseAvailable) return Promise.resolve({ docs: [] })
      leaseAvailable = false
    }
    return Promise.resolve({ docs: [receipt] })
  })
  const upstream = vi.fn().mockResolvedValue({
    data: {
      operation_id: operationId,
      status: 'succeeded',
      updated_at: '2026-08-04T03:00:00.000Z',
    },
  })
  const common = {
    clock: () => new Date('2026-08-04T03:01:00.000Z'),
    payload: { create, find, findByID: vi.fn(), update },
    upstream,
  }

  const processed = await Promise.all([
    reconcileCloudOperationReceipts({ ...common, ownerId: 'admin-process-a' }),
    reconcileCloudOperationReceipts({ ...common, ownerId: 'admin-process-b' }),
  ])

  expect(processed[0] + processed[1]).toBe(1)
  expect(upstream).toHaveBeenCalledTimes(1)
  expect(create).toHaveBeenCalledTimes(1)
})

it('replays the stored idempotent mutation only when Cloud proves the operation is absent', async () => {
  const receipt = pendingReceipt()
  const create = vi.fn().mockResolvedValue({ id: 90 })
  const find = vi.fn().mockResolvedValue({ docs: [receipt] })
  const update = vi.fn().mockResolvedValue({ docs: [receipt] })
  const upstream = vi
    .fn()
    .mockRejectedValueOnce(new PlatformAPIError('OPERATION_NOT_FOUND', 404, receipt.requestId))
    .mockResolvedValueOnce({
      data: {
        operation_id: operationId,
        status: 'succeeded',
        updated_at: '2026-08-04T03:00:00.000Z',
      },
    })

  const processed = await reconcileCloudOperationReceipts({
    clock: () => new Date('2026-08-04T03:01:00.000Z'),
    ownerId: 'admin-process-a',
    payload: { create, find, findByID: vi.fn(), update },
    upstream,
  })

  expect(processed).toBe(1)
  expect(upstream).toHaveBeenCalledTimes(2)
  expect(upstream.mock.calls[0][0]).toEqual({
    method: 'GET',
    path: `/operations/${operationId}`,
    requestId: receipt.requestId,
  })
  expect(upstream.mock.calls[1][0]).toMatchObject({
    actor: undefined,
    body: receipt.request.body,
    idempotencyKey: operationId,
    method: 'POST',
    path: receipt.request.path,
    requestId: receipt.requestId,
  })
  expect(update).toHaveBeenCalledWith(
    expect.objectContaining({
      collection: 'cloud-operation-receipts',
      data: expect.objectContaining({ status: 'succeeded' }),
    }),
  )
})

it('finishes the approved rollback locally after Cloud succeeded', async () => {
  const receipt = {
    ...pendingReceipt(),
    capability: 'official-agents:rollback:write',
    localActorRole: 'super_admin',
    operationKey: 'rollbackOfficialRelease',
    rollbackRequestId: '42',
  }
  const create = vi.fn().mockResolvedValue({ id: 90 })
  const find = vi.fn().mockResolvedValue({ docs: [receipt] })
  const findByID = vi.fn().mockResolvedValue({ id: 42, status: 'approved' })
  const update = vi
    .fn()
    .mockImplementation(({ collection }) =>
      Promise.resolve(
        collection === 'official-rollback-requests' ? { id: 42 } : { docs: [receipt] },
      ),
    )
  const upstream = vi.fn().mockResolvedValue({
    data: {
      operation_id: operationId,
      status: 'succeeded',
      updated_at: '2026-08-04T03:00:00.000Z',
    },
  })

  await reconcileCloudOperationReceipts({
    clock: () => new Date('2026-08-04T03:01:00.000Z'),
    ownerId: 'admin-process-a',
    payload: { create, find, findByID, update },
    upstream,
  })

  expect(findByID).toHaveBeenCalledWith(
    expect.objectContaining({
      collection: 'official-rollback-requests',
      id: '42',
      overrideAccess: true,
    }),
  )
  expect(update).toHaveBeenCalledWith(
    expect.objectContaining({
      collection: 'official-rollback-requests',
      data: expect.objectContaining({ operationId, status: 'executed' }),
      id: '42',
    }),
  )
  expect(update).toHaveBeenCalledWith(
    expect.objectContaining({
      collection: 'cloud-operation-receipts',
      data: expect.objectContaining({
        rollbackCompletedAt: expect.any(String),
        status: 'succeeded',
      }),
    }),
  )
})

it('converges exactly once when the audit exists but its receipt flag was not saved', async () => {
  const receipt = pendingReceipt()
  const create = vi.fn().mockRejectedValue(new Error('unique operation id'))
  const find = vi.fn().mockImplementation(({ collection }) =>
    Promise.resolve({
      docs:
        collection === 'cloud-operation-receipts'
          ? [receipt]
          : [{ id: 90, operationId: receipt.operationId }],
    }),
  )
  const update = vi.fn().mockResolvedValue({ docs: [receipt] })
  const upstream = vi.fn().mockResolvedValue({
    data: {
      operation_id: operationId,
      status: 'succeeded',
      updated_at: '2026-08-04T03:00:00.000Z',
    },
  })

  await reconcileCloudOperationReceipts({
    clock: () => new Date('2026-08-04T03:01:00.000Z'),
    ownerId: 'admin-process-a',
    payload: { create, find, findByID: vi.fn(), update },
    upstream,
  })

  expect(create).toHaveBeenCalledTimes(1)
  expect(find).toHaveBeenCalledWith(
    expect.objectContaining({
      collection: 'audit-logs',
      where: { operationId: { equals: operationId } },
    }),
  )
  expect(update).toHaveBeenCalledWith(
    expect.objectContaining({
      collection: 'cloud-operation-receipts',
      data: expect.objectContaining({
        auditCompletedAt: expect.any(String),
        status: 'succeeded',
      }),
    }),
  )
})

it('starts reconciliation on process init and prevents timer re-entry', async () => {
  vi.useFakeTimers()
  try {
    let releaseFind: ((value: { docs: unknown[] }) => void) | undefined
    const find = vi.fn().mockImplementation(
      () =>
        new Promise<{ docs: unknown[] }>((resolve) => {
          releaseFind = resolve
        }),
    )
    const start = (
      receiptAPI as unknown as {
        startCloudOperationReconciliation?: (options: Record<string, unknown>) => {
          runNow: () => Promise<void>
          stop: () => void
        }
      }
    ).startCloudOperationReconciliation

    expect(start).toBeTypeOf('function')
    const loop = start?.({
      intervalMs: 15_000,
      ownerId: 'admin-process-a',
      payload: { create: vi.fn(), find, findByID: vi.fn(), update: vi.fn() },
      upstream: vi.fn(),
    })
    await Promise.resolve()
    expect(find).toHaveBeenCalledTimes(1)

    await loop?.runNow()
    expect(find).toHaveBeenCalledTimes(1)

    releaseFind?.({ docs: [] })
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(15_000)
    expect(find).toHaveBeenCalledTimes(2)
    loop?.stop()
  } finally {
    vi.useRealTimers()
  }
})

it('finishes a persisted definitive rejection locally without replaying Cloud', async () => {
  const receipt = {
    ...pendingReceipt(),
    definitiveFailure: true,
    errorCode: 'INVALID_REQUEST',
    status: 'reconciling',
  }
  const create = vi.fn().mockResolvedValue({ id: 90 })
  const find = vi.fn().mockResolvedValue({ docs: [receipt] })
  const update = vi.fn().mockResolvedValue({ docs: [receipt] })
  const upstream = vi.fn()

  await reconcileCloudOperationReceipts({
    clock: () => new Date('2026-08-04T03:01:00.000Z'),
    ownerId: 'admin-process-a',
    payload: { create, find, findByID: vi.fn(), update },
    upstream,
  })

  expect(upstream).not.toHaveBeenCalled()
  expect(create).toHaveBeenCalledWith(
    expect.objectContaining({
      collection: 'audit-logs',
      data: expect.objectContaining({ errorCode: 'INVALID_REQUEST', outcome: 'failed' }),
    }),
  )
  expect(update).toHaveBeenCalledWith(
    expect.objectContaining({
      collection: 'cloud-operation-receipts',
      data: expect.objectContaining({ status: 'failed' }),
    }),
  )
})

it('wires durable receipt recovery into Payload process initialization', async () => {
  const config = await configPromise
  expect(config.onInit).toBeTypeOf('function')
  const payload = await getTestPayload()
  expect(payload.db.busyTimeout).toBe(5_000)
})

it('keeps the production migration idempotent and enforces receipt operation id uniqueness', async () => {
  const payload = await getTestPayload()
  await migrateOperationReceipts({ db: payload.db.drizzle, payload, req: { payload } } as never)
  await migrateOperationReceipts({ db: payload.db.drizzle, payload, req: { payload } } as never)

  const receipt = pendingReceipt()
  await payload.create({
    collection: 'cloud-operation-receipts',
    data: receipt,
    overrideAccess: true,
  })
  await expect(
    payload.create({
      collection: 'cloud-operation-receipts',
      data: receipt,
      overrideAccess: true,
    }),
  ).rejects.toThrow()
  await payload.delete({
    collection: 'cloud-operation-receipts',
    overrideAccess: true,
    where: { operationId: { equals: operationId } },
  })
})

it('claims one real SQLite lease when two Admin processes reconcile concurrently', async () => {
  const payload = await getTestPayload()
  const receipt = pendingReceipt()
  await payload.create({
    collection: 'cloud-operation-receipts',
    data: receipt,
    overrideAccess: true,
  })
  const upstream = vi.fn().mockResolvedValue({
    data: {
      operation_id: operationId,
      status: 'succeeded',
      updated_at: '2026-08-04T03:00:00.000Z',
    },
  })

  const processed = await Promise.all([
    reconcileCloudOperationReceipts({ ownerId: 'admin-process-a', payload, upstream }),
    reconcileCloudOperationReceipts({ ownerId: 'admin-process-b', payload, upstream }),
  ])

  expect(processed[0] + processed[1]).toBe(1)
  expect(upstream).toHaveBeenCalledTimes(1)
  const stored = await payload.find({
    collection: 'cloud-operation-receipts',
    overrideAccess: true,
    where: { operationId: { equals: operationId } },
  })
  expect(stored.docs[0]).toMatchObject({ status: 'succeeded' })
  const audits = await payload.find({
    collection: 'audit-logs',
    overrideAccess: true,
    where: { operationId: { equals: operationId } },
  })
  expect(audits.docs).toHaveLength(1)

  await payload.delete({
    collection: 'audit-logs',
    overrideAccess: true,
    where: { operationId: { equals: operationId } },
  })
  await payload.delete({
    collection: 'cloud-operation-receipts',
    overrideAccess: true,
    where: { operationId: { equals: operationId } },
  })
})
