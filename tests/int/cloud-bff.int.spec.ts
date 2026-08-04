import { generateKeyPairSync, verify as verifyRaw } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'

import { PlatformAPIError } from '../../src/platform-api/client'
import { createCloudHandler } from '../../src/platform-api/cloud/handler'
import { getCloudAdminConfig } from '../../src/platform-api/cloud/config'
import { cloudOperations, type CloudOperation } from '../../src/platform-api/cloud/operations'
import { createTokenSource, validActorContext } from '../../src/platform-api/cloud/token'

const registry = cloudOperations as Record<string, CloudOperation>

const validEnvironment = {
  AGENTERA_CLOUD_ADMIN_BASE_URL: 'https://127.0.0.1:18443',
  AGENTERA_CLOUD_ADMIN_CA_FILE: '/tmp/pki/ca.pem',
  AGENTERA_CLOUD_ADMIN_CLIENT_CERT_FILE: '/tmp/pki/client.pem',
  AGENTERA_CLOUD_ADMIN_CLIENT_KEY_FILE: '/tmp/pki/client-key.pem',
  AGENTERA_CLOUD_ADMIN_JWT_SIGNING_KEY_FILE: '/tmp/pki/service-key.pem',
  AGENTERA_CLOUD_ADMIN_JWT_ISSUER: 'agentera-admin',
  AGENTERA_CLOUD_ADMIN_JWT_SUBJECT: 'agentera-admin-dev',
  AGENTERA_CLOUD_ADMIN_SCOPES: '["users:read","official_agents:read"]',
}

describe('cloud admin configuration', () => {
  it('accepts a complete https configuration', () => {
    const config = getCloudAdminConfig(validEnvironment)
    expect(config.configured).toBe(true)
    if (config.configured) {
      expect(config.baseURL.toString()).toBe('https://127.0.0.1:18443/')
      expect(config.scopes).toEqual(['users:read', 'official_agents:read'])
      expect(config.timeoutMs).toBe(5_000)
    }
  })

  it('reports missing configuration when the base URL is absent', () => {
    const config = getCloudAdminConfig({})
    expect(config).toMatchObject({ configured: false, errorCode: 'missing_configuration' })
  })

  it.each([
    ['http origin', { AGENTERA_CLOUD_ADMIN_BASE_URL: 'http://127.0.0.1:18443' }],
    ['origin with path', { AGENTERA_CLOUD_ADMIN_BASE_URL: 'https://c.example.test/admin' }],
    ['relative CA path', { AGENTERA_CLOUD_ADMIN_CA_FILE: 'certs/ca.pem' }],
    ['invalid issuer', { AGENTERA_CLOUD_ADMIN_JWT_ISSUER: 'Bad Issuer!' }],
    ['empty scopes', { AGENTERA_CLOUD_ADMIN_SCOPES: '[]' }],
    ['duplicate scopes', { AGENTERA_CLOUD_ADMIN_SCOPES: '["users:read","users:read"]' }],
  ])('rejects %s', (_label, override) => {
    const config = getCloudAdminConfig({ ...validEnvironment, ...override })
    expect(config).toMatchObject({ configured: false, errorCode: 'invalid_configuration' })
  })
})

describe('cloud service JWT', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const source = createTokenSource({
    clock: () => new Date('2026-07-25T10:00:00Z'),
    issuer: 'agentera-admin',
    privateKey,
    scopes: ['users:read', 'official_agents:read'],
    subject: 'agentera-admin-dev',
  })
  const adminId = '0a4c2f5e-1c3b-4d5e-8f90-123456789abc'
  const requesterId = '1b5d3f6e-2d4c-5e6f-9a01-23456789abcd'
  const operationId = '2c6e4a7f-3e5d-6f70-ab12-3456789abcde'
  const approvalId = '3d7f5b80-4f6e-7081-bc23-456789abcdef'

  function decode(token: string) {
    const [header, claims, signature] = token.split('.')
    return {
      claims: JSON.parse(Buffer.from(claims, 'base64url').toString('utf8')),
      header: JSON.parse(Buffer.from(header, 'base64url').toString('utf8')),
      signatureValid: verifyRaw(
        null,
        Buffer.from(`${header}.${claims}`),
        publicKey,
        Buffer.from(signature, 'base64url'),
      ),
    }
  }

  it('signs EdDSA tokens with the exact aera-cloud claim contract', () => {
    const decoded = decode(source.token())
    expect(decoded.header).toEqual({ alg: 'EdDSA', typ: 'JWT' })
    expect(decoded.signatureValid).toBe(true)
    expect(decoded.claims).toMatchObject({
      aud: 'aera-cloud-admin',
      iss: 'agentera-admin',
      sub: 'agentera-admin-dev',
      scope: ['users:read', 'official_agents:read'],
    })
    expect(decoded.claims.exp - decoded.claims.iat).toBe(300)
    expect(decoded.claims.nbf).toBe(decoded.claims.iat - 5)
    expect(decoded.claims.jti).toMatch(/^[A-Za-z0-9_-]{16,128}$/)
    expect(decoded.claims.admin_id).toBeUndefined()
  })

  it('emits mutation and rollback actor claims', () => {
    const mutation = decode(source.token({ adminId, operationId, role: 'developer' })).claims
    expect(mutation).toMatchObject({
      admin_id: adminId,
      admin_role: 'developer',
      operation_id: operationId,
    })
    expect(mutation.approval_id).toBeUndefined()

    const rollback = decode(
      source.token({
        adminId,
        approvalId,
        operationId,
        requesterAdminId: requesterId,
        role: 'super_admin',
      }),
    ).claims
    expect(rollback).toMatchObject({
      admin_id: adminId,
      approval_id: approvalId,
      operation_id: operationId,
      requester_admin_id: requesterId,
    })
  })

  it('rejects invalid actor contexts before signing', () => {
    expect(validActorContext({ adminId: 'not-a-uuid', role: 'operator' })).toBe(false)
    expect(
      validActorContext({
        adminId,
        approvalId,
        operationId,
        requesterAdminId: adminId,
        role: 'operator',
      }),
    ).toBe(false)
    expect(validActorContext({ adminId, approvalId, role: 'operator' })).toBe(false)
    expect(validActorContext({ adminId, role: 'root' })).toBe(false)
    expect(() => source.token({ adminId: 'broken', role: 'operator' })).toThrow()
    expect(() => source.token({ adminId, role: 'root' })).toThrow()
  })
})

describe('cloud operation registry', () => {
  it('registers actual aera-cloud internal admin paths', () => {
    expect(registry.listCloudUsers.upstreamPath({})).toBe('/users')
    expect(registry.getCloudUser.upstreamPath({ user_id: 'u1' })).toBe('/users/u1')
    expect(registry.revokeCloudDevice.upstreamPath({ device_id: 'd1' })).toBe('/devices/d1/revoke')
    expect(registry.revokeAllCloudSessions.upstreamPath({ user_id: 'u1' })).toBe(
      '/users/u1/sessions/revoke-all',
    )
    expect(registry.listOfficialDrafts.upstreamPath({})).toBe('/official-agent-drafts')
    expect(registry.rollbackOfficialRelease.upstreamPath({ release_id: 'r1' })).toBe(
      '/official-agent-releases/r1/rollback',
    )
  })

  it('locks high-risk operations behind reauthentication and approvals', () => {
    expect(registry.resetCloudUserPassword).toMatchObject({
      capability: 'cloud:users:write',
      requiresReauthentication: true,
      risk: 'high',
    })
    expect(registry.rollbackOfficialRelease).toMatchObject({
      capability: 'official-agents:rollback:write',
      kind: 'official-rollback',
      requiredActorRole: 'super_admin',
      requiresReauthentication: true,
      risk: 'high',
    })
    expect(registry.disableCloudUser.requiresApproval).toBe(true)
    expect(registry.enableCloudUser.requiresApproval).toBe(true)
  })

  it('declares required Cloud roles without carrying an actor role override', () => {
    expect(registry.reserveOfficialDefinition).toMatchObject({ requiredActorRole: 'developer' })
    expect(registry.reviewOfficialSubmission).toMatchObject({ requiredActorRole: 'super_admin' })
    expect(registry.activateOfficialRelease).toMatchObject({ requiredActorRole: 'operator' })
    for (const operation of Object.values(cloudOperations)) {
      expect(operation).not.toHaveProperty('dutyRole')
    }
  })

  it('keeps reads free of mutation flags', () => {
    for (const operation of Object.values(cloudOperations)) {
      if (operation.kind === 'read' || operation.kind === 'official-read') {
        expect(operation.mutation).toBe(false)
      }
    }
  })
})

type HandlerRequestOptions = {
  body?: unknown
  create?: ReturnType<typeof vi.fn>
  find?: ReturnType<typeof vi.fn>
  findByID?: ReturnType<typeof vi.fn>
  method?: string
  operation: string
  query?: string
  role?: string
  update?: ReturnType<typeof vi.fn>
}

const actorUUID = '7f3e9a10-6b2c-4d8e-9f01-abcdef012345'

function handlerRequest(options: HandlerRequestOptions) {
  return {
    headers: new Headers({ 'x-request-id': 'cloud-request-1' }),
    json: vi.fn().mockResolvedValue(options.body),
    method: options.method || 'GET',
    payload: {
      create: options.create || vi.fn().mockResolvedValue({ id: 1 }),
      find: options.find || vi.fn().mockResolvedValue({ docs: [] }),
      findByID: options.findByID || vi.fn().mockResolvedValue({ id: 7 }),
      update: options.update || vi.fn().mockResolvedValue({ id: 1 }),
    },
    routeParams: { operation: options.operation },
    url: `http://localhost/api/cloud/v1/${options.operation}${options.query || ''}`,
    user: options.role
      ? { cloudActorId: actorUUID, email: 'ops@agentera.local', id: 7, role: options.role }
      : undefined,
  }
}

describe('cloud BFF handler', () => {
  it('rejects anonymous, unauthorized, unknown and mismatched requests before upstream', async () => {
    const upstream = vi.fn()
    const handler = createCloudHandler(upstream)

    const anonymous = await handler(handlerRequest({ operation: 'listCloudUsers' }) as never)
    const forbidden = await handler(
      handlerRequest({ operation: 'listCloudUsers', role: 'finance_admin' }) as never,
    )
    const unknown = await handler(
      handlerRequest({ operation: 'notRegistered', role: 'super_admin' }) as never,
    )
    const wrongMethod = await handler(
      handlerRequest({ method: 'POST', operation: 'listCloudUsers', role: 'super_admin' }) as never,
    )

    expect(anonymous.status).toBe(401)
    expect(forbidden.status).toBe(403)
    expect(unknown.status).toBe(404)
    expect(wrongMethod.status).toBe(405)
    expect(upstream).not.toHaveBeenCalled()
  })

  it('wraps user commands into the admin.Command envelope with a UUID idempotency key', async () => {
    const upstream = vi.fn().mockResolvedValue({
      data: { operation_id: 'op', status: 'succeeded' },
      upstreamRequestId: 'cloud-9',
    })
    const handler = createCloudHandler(upstream)
    const response = await handler(
      handlerRequest({
        body: { expected_revision: 3, note: '滥用', reason_code: 'abuse_report' },
        method: 'POST',
        operation: 'revokeCloudSession',
        query: `?session_id=${actorUUID}`,
        role: 'operations_admin',
      }) as never,
    )

    expect(response.status).toBe(200)
    const call = upstream.mock.calls[0][0]
    expect(call.path).toBe(`/sessions/${actorUUID}/revoke`)
    expect(call.body).toMatchObject({
      actor_admin_id: actorUUID,
      expected_revision: 3,
      note: '滥用',
      reason_code: 'abuse_report',
      request_id: 'cloud-request-1',
    })
    expect(call.body.operation_id).toMatch(/^[0-9a-f-]{36}$/)
    expect(call.idempotencyKey).toBe(call.body.operation_id)
    expect(call.actor).toBeUndefined()
  })

  it('persists a durable receipt before sending a mutation with the same operation id', async () => {
    const events: string[] = []
    const create = vi.fn().mockImplementation(({ collection, data }) => {
      events.push(`create:${collection}`)
      return Promise.resolve({ ...data, id: 11 })
    })
    const upstream = vi.fn().mockImplementation((request) => {
      events.push('upstream')
      return Promise.resolve({
        data: { operation_id: request.idempotencyKey, status: 'succeeded' },
      })
    })
    const handler = createCloudHandler(upstream)

    const response = await handler(
      handlerRequest({
        body: { expected_revision: 3, note: '滥用', reason_code: 'abuse_report' },
        create,
        method: 'POST',
        operation: 'revokeCloudSession',
        query: `?session_id=${actorUUID}`,
        role: 'operations_admin',
      }) as never,
    )

    expect(response.status).toBe(200)
    expect(events.slice(0, 2)).toEqual(['create:cloud-operation-receipts', 'upstream'])
    const receipt = create.mock.calls[0][0]
    const request = upstream.mock.calls[0][0]
    expect(receipt).toMatchObject({
      collection: 'cloud-operation-receipts',
      data: {
        actorAdminId: actorUUID,
        actorRole: 'operator',
        operationKey: 'revokeCloudSession',
        requestId: 'cloud-request-1',
        status: 'pending',
      },
      overrideAccess: true,
    })
    expect(receipt.data.operationId).toBe(request.idempotencyKey)
    expect(receipt.data.operationId).toBe(request.body.operation_id)
  })

  it('does not contact Cloud when the durable receipt cannot be persisted', async () => {
    const create = vi.fn().mockRejectedValue(new Error('sqlite unavailable'))
    const upstream = vi.fn()
    const handler = createCloudHandler(upstream)

    const response = await handler(
      handlerRequest({
        body: { expected_revision: 3, reason_code: 'abuse_report' },
        create,
        method: 'POST',
        operation: 'revokeCloudSession',
        query: `?session_id=${actorUUID}`,
        role: 'operations_admin',
      }) as never,
    )

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'LOCAL_OPERATION_RECEIPT_UNAVAILABLE' },
    })
    expect(upstream).not.toHaveBeenCalled()
  })

  it('stores the replayable allowlisted request without transport credentials', async () => {
    const create = vi.fn().mockResolvedValue({ id: 11 })
    const upstream = vi.fn().mockImplementation((request) =>
      Promise.resolve({
        data: {
          operation_id: request.idempotencyKey,
          status: 'succeeded',
          updated_at: '2026-08-04T03:00:00.000Z',
        },
      }),
    )
    const handler = createCloudHandler(upstream)

    await handler(
      handlerRequest({
        body: { expected_revision: 3, note: '滥用', reason_code: 'abuse_report' },
        create,
        method: 'POST',
        operation: 'revokeCloudSession',
        query: `?session_id=${actorUUID}`,
        role: 'operations_admin',
      }) as never,
    )

    const receipt = create.mock.calls[0][0].data
    expect(receipt).toMatchObject({
      capability: 'cloud:sessions:write',
      localActorId: '7',
      localActorRole: 'operations_admin',
      request: {
        actor: null,
        body: {
          actor_admin_id: actorUUID,
          expected_revision: 3,
          note: '滥用',
          reason_code: 'abuse_report',
          request_id: 'cloud-request-1',
        },
        method: 'POST',
        path: `/sessions/${actorUUID}/revoke`,
        query: '',
        requestId: 'cloud-request-1',
      },
    })
    expect(receipt.request.idempotencyKey).toBe(receipt.operationId)
    expect(receipt.request.body.operation_id).toBe(receipt.operationId)
    expect(receipt.request).not.toHaveProperty('headers')
    expect(receipt.request).not.toHaveProperty('signal')
    expect(JSON.stringify(receipt.request)).not.toContain('authorization')
  })

  it('queries Cloud immediately by operation id after an ambiguous mutation result', async () => {
    const upstream = vi.fn().mockImplementation((request) => {
      if (request.method === 'POST') {
        throw new PlatformAPIError('UPSTREAM_TIMEOUT', 504, request.requestId)
      }
      return Promise.resolve({
        data: {
          operation_id: request.path.split('/').at(-1),
          status: 'succeeded',
          updated_at: '2026-08-04T03:00:00.000Z',
        },
        upstreamRequestId: 'cloud-reconcile-1',
      })
    })
    const handler = createCloudHandler(upstream)

    const response = await handler(
      handlerRequest({
        body: { expected_revision: 3, reason_code: 'abuse_report' },
        method: 'POST',
        operation: 'revokeCloudSession',
        query: `?session_id=${actorUUID}`,
        role: 'operations_admin',
      }) as never,
    )

    expect(response.status).toBe(200)
    expect(upstream).toHaveBeenCalledTimes(2)
    const mutation = upstream.mock.calls[0][0]
    expect(upstream.mock.calls[1][0]).toMatchObject({
      method: 'GET',
      path: `/operations/${mutation.idempotencyKey}`,
      requestId: 'cloud-request-1',
    })
    await expect(response.json()).resolves.toMatchObject({
      data: { operation_id: mutation.idempotencyKey, status: 'succeeded' },
      meta: { upstreamRequestId: 'cloud-reconcile-1' },
    })
  })

  it('keeps an unresolved ambiguous result pending without writing a false failure audit', async () => {
    const create = vi.fn().mockResolvedValue({ id: 11 })
    const update = vi.fn().mockResolvedValue({ docs: [{ id: 11 }] })
    const upstream = vi.fn().mockImplementation((request) => {
      throw new PlatformAPIError('UPSTREAM_TIMEOUT', 504, request.requestId)
    })
    const handler = createCloudHandler(upstream)

    const response = await handler(
      handlerRequest({
        body: { expected_revision: 3, reason_code: 'abuse_report' },
        create,
        method: 'POST',
        operation: 'revokeCloudSession',
        query: `?session_id=${actorUUID}`,
        role: 'operations_admin',
        update,
      }) as never,
    )

    expect(response.status).toBe(202)
    expect(upstream).toHaveBeenCalledTimes(2)
    expect(create).toHaveBeenCalledTimes(1)
    const operationId = upstream.mock.calls[0][0].idempotencyKey
    expect(update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        collection: 'cloud-operation-receipts',
        data: expect.objectContaining({
          lastErrorCode: 'UPSTREAM_TIMEOUT',
          status: 'reconciling',
        }),
        where: { operationId: { equals: operationId } },
      }),
    )
    await expect(response.json()).resolves.toMatchObject({
      data: { operation_id: operationId, status: 'queued' },
    })
  })

  it('records a terminal Cloud result on the durable receipt', async () => {
    const update = vi.fn().mockResolvedValue({ docs: [{ id: 11 }] })
    const upstream = vi.fn().mockImplementation((request) =>
      Promise.resolve({
        data: {
          administrative_revision: 4,
          operation_id: request.idempotencyKey,
          status: 'succeeded',
          updated_at: '2026-08-04T03:00:00.000Z',
        },
        upstreamRequestId: 'cloud-terminal-1',
      }),
    )
    const handler = createCloudHandler(upstream)

    const response = await handler(
      handlerRequest({
        body: { expected_revision: 3, reason_code: 'abuse_report' },
        method: 'POST',
        operation: 'revokeCloudSession',
        query: `?session_id=${actorUUID}`,
        role: 'operations_admin',
        update,
      }) as never,
    )

    expect(response.status).toBe(200)
    const operationId = upstream.mock.calls[0][0].idempotencyKey
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        collection: 'cloud-operation-receipts',
        data: expect.objectContaining({
          administrativeRevision: 4,
          cloudUpdatedAt: '2026-08-04T03:00:00.000Z',
          status: 'succeeded',
          upstreamRequestId: 'cloud-terminal-1',
        }),
        overrideAccess: true,
        where: { operationId: { equals: operationId } },
      }),
    )
  })

  it('keeps a Cloud success reconcilable when the local audit write fails', async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce({ id: 11 })
      .mockRejectedValueOnce(new Error('audit sqlite write failed'))
    const find = vi.fn().mockResolvedValue({ docs: [] })
    const update = vi.fn().mockResolvedValue({ docs: [{ id: 11 }] })
    const upstream = vi.fn().mockImplementation((request) =>
      Promise.resolve({
        data: {
          operation_id: request.idempotencyKey,
          status: 'succeeded',
          updated_at: '2026-08-04T03:00:00.000Z',
        },
      }),
    )
    const handler = createCloudHandler(upstream)

    const response = await handler(
      handlerRequest({
        body: { expected_revision: 3, reason_code: 'abuse_report' },
        create,
        find,
        method: 'POST',
        operation: 'revokeCloudSession',
        query: `?session_id=${actorUUID}`,
        role: 'operations_admin',
        update,
      }) as never,
    )

    expect(response.status).toBe(200)
    expect(upstream).toHaveBeenCalledTimes(1)
    expect(update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        collection: 'cloud-operation-receipts',
        data: expect.objectContaining({
          cloudStatus: 'succeeded',
          lastErrorCode: 'LOCAL_AUDIT_PENDING',
          status: 'reconciling',
        }),
      }),
    )
  })

  it('returns the Cloud success once when the receipt finalization write fails', async () => {
    const create = vi.fn().mockResolvedValue({ id: 11 })
    const update = vi.fn().mockRejectedValue(new Error('receipt finalization write failed'))
    const upstream = vi.fn().mockImplementation((request) =>
      Promise.resolve({
        data: {
          operation_id: request.idempotencyKey,
          status: 'succeeded',
          updated_at: '2026-08-04T03:00:00.000Z',
        },
      }),
    )
    const handler = createCloudHandler(upstream)

    const response = await handler(
      handlerRequest({
        body: { expected_revision: 3, reason_code: 'abuse_report' },
        create,
        method: 'POST',
        operation: 'revokeCloudSession',
        query: `?session_id=${actorUUID}`,
        role: 'operations_admin',
        update,
      }) as never,
    )

    expect(response.status).toBe(200)
    expect(upstream).toHaveBeenCalledTimes(1)
    expect(create).toHaveBeenCalledTimes(2)
  })

  it('closes the receipt after a definitive Cloud rejection', async () => {
    const create = vi.fn().mockResolvedValue({ id: 11 })
    const update = vi.fn().mockResolvedValue({ docs: [{ id: 11 }] })
    const upstream = vi
      .fn()
      .mockRejectedValue(new PlatformAPIError('INVALID_REQUEST', 400, 'cloud-request-1'))
    const handler = createCloudHandler(upstream)

    const response = await handler(
      handlerRequest({
        body: { expected_revision: 3, reason_code: 'abuse_report' },
        create,
        method: 'POST',
        operation: 'revokeCloudSession',
        query: `?session_id=${actorUUID}`,
        role: 'operations_admin',
        update,
      }) as never,
    )

    expect(response.status).toBe(400)
    expect(upstream).toHaveBeenCalledTimes(1)
    expect(update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        collection: 'cloud-operation-receipts',
        data: expect.objectContaining({
          auditCompletedAt: expect.any(String),
          errorCode: 'INVALID_REQUEST',
          status: 'failed',
        }),
      }),
    )
  })

  it('reconciles a 409 response into the Cloud conflict terminal state', async () => {
    const create = vi.fn().mockResolvedValue({ id: 11 })
    const update = vi.fn().mockResolvedValue({ docs: [{ id: 11 }] })
    const upstream = vi.fn().mockImplementation((request) => {
      if (request.method !== 'GET') {
        throw new PlatformAPIError('STATE_CONFLICT', 409, request.requestId)
      }
      return Promise.resolve({
        data: {
          error_code: 'USER_STATE_CONFLICT',
          operation_id: request.path.split('/').at(-1),
          status: 'conflict',
          updated_at: '2026-08-04T03:00:00.000Z',
        },
      })
    })
    const handler = createCloudHandler(upstream)

    const response = await handler(
      handlerRequest({
        body: { expected_revision: 3, reason_code: 'abuse_report' },
        create,
        method: 'POST',
        operation: 'revokeCloudSession',
        query: `?session_id=${actorUUID}`,
        role: 'operations_admin',
        update,
      }) as never,
    )

    expect(response.status).toBe(200)
    expect(upstream).toHaveBeenCalledTimes(2)
    expect(update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        collection: 'cloud-operation-receipts',
        data: expect.objectContaining({
          cloudStatus: 'conflict',
          errorCode: 'USER_STATE_CONFLICT',
          status: 'conflict',
        }),
      }),
    )
  })

  it('requires an approval id for account disable commands', async () => {
    const upstream = vi.fn().mockResolvedValue({ data: {} })
    const handler = createCloudHandler(upstream)
    await handler(
      handlerRequest({
        body: { expected_revision: 1, reason_code: 'policy_violation' },
        method: 'POST',
        operation: 'disableCloudUser',
        query: `?user_id=${actorUUID}`,
        role: 'super_admin',
      }) as never,
    )
    expect(upstream.mock.calls[0][0].body.approval_id).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('rejects malformed command bodies without contacting upstream', async () => {
    const upstream = vi.fn()
    const handler = createCloudHandler(upstream)
    const response = await handler(
      handlerRequest({
        body: { expected_revision: 0, reason_code: 'Bad-Reason' },
        method: 'POST',
        operation: 'revokeCloudSession',
        query: `?session_id=${actorUUID}`,
        role: 'super_admin',
      }) as never,
    )
    expect(response.status).toBe(400)
    expect(upstream).not.toHaveBeenCalled()
  })

  it('wraps official mutations and attaches the matching actor claims', async () => {
    const upstream = vi.fn().mockResolvedValue({ data: { operation_id: 'op-1' } })
    const handler = createCloudHandler(upstream)
    await handler(
      handlerRequest({
        body: {
          expected_revision: 1,
          payload: { display_name: '官方助理' },
          reason_code: 'routine_release',
        },
        method: 'POST',
        operation: 'reserveOfficialDefinition',
        role: 'publisher',
      }) as never,
    )

    const call = upstream.mock.calls[0][0]
    expect(call.body).toMatchObject({
      actor_admin_id: actorUUID,
      actor_admin_role: 'developer',
      expected_revision: 1,
      payload: { display_name: '官方助理' },
      reason_code: 'routine_release',
    })
    expect(call.actor).toMatchObject({
      adminId: actorUUID,
      operationId: call.body.operation_id,
      role: 'developer',
    })
    expect(call.idempotencyKey).toBe(call.body.operation_id)
  })

  it('rejects capability and Cloud duty mismatches without forging actor roles', async () => {
    const upstream = vi.fn().mockResolvedValue({ data: { operation_id: 'op-1' } })
    const handler = createCloudHandler(upstream)
    const cases = [
      {
        operation: 'reserveOfficialDefinition',
        role: 'publisher',
        status: 200,
        cloudRole: 'developer',
      },
      {
        operation: 'activateOfficialRelease',
        role: 'operations_admin',
        status: 200,
        cloudRole: 'operator',
      },
      {
        operation: 'reviewOfficialSubmission',
        role: 'super_admin',
        status: 200,
        cloudRole: 'super_admin',
      },
      { operation: 'reviewOfficialSubmission', role: 'publisher', status: 403 },
      { operation: 'reserveOfficialDefinition', role: 'operations_admin', status: 403 },
      { operation: 'reserveOfficialDefinition', role: 'super_admin', status: 403 },
      { operation: 'activateOfficialRelease', role: 'super_admin', status: 403 },
      { operation: 'reserveOfficialDefinition', role: 'auditor', status: 403 },
    ] as const

    for (const test of cases) {
      upstream.mockClear()
      const pathParam =
        test.operation === 'reviewOfficialSubmission'
          ? `?submission_id=${actorUUID}`
          : test.operation === 'activateOfficialRelease'
            ? `?release_id=${actorUUID}`
            : ''
      const response = await handler(
        handlerRequest({
          body: { expected_revision: 1, payload: {}, reason_code: 'duty_check' },
          method: 'POST',
          operation: test.operation,
          query: pathParam,
          role: test.role,
        }) as never,
      )

      expect(response.status, `${test.role}:${test.operation}`).toBe(test.status)
      if (test.status === 200) {
        const call = upstream.mock.calls[0][0]
        expect(call.actor.role).toBe(test.cloudRole)
        expect(call.body.actor_admin_role).toBe(test.cloudRole)
      } else {
        expect(upstream).not.toHaveBeenCalled()
      }
    }
  })

  it('blocks high-risk operations with 428 until a recent step-up exists', async () => {
    const upstream = vi.fn()
    const handler = createCloudHandler(upstream)
    const notEnrolled = await handler(
      handlerRequest({
        body: { expected_revision: 1, reason_code: 'user_request' },
        findByID: vi.fn().mockResolvedValue({ id: 7 }),
        method: 'POST',
        operation: 'resetCloudUserPassword',
        query: `?user_id=${actorUUID}`,
        role: 'super_admin',
      }) as never,
    )
    expect(notEnrolled.status).toBe(428)
    await expect(notEnrolled.json()).resolves.toMatchObject({
      error: { code: 'TOTP_NOT_ENROLLED' },
    })

    const stale = await handler(
      handlerRequest({
        body: { expected_revision: 1, reason_code: 'user_request' },
        findByID: vi.fn().mockResolvedValue({
          id: 7,
          stepUpVerifiedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
          totpEnabledAt: '2026-07-01T00:00:00.000Z',
        }),
        method: 'POST',
        operation: 'resetCloudUserPassword',
        query: `?user_id=${actorUUID}`,
        role: 'super_admin',
      }) as never,
    )
    expect(stale.status).toBe(428)
    await expect(stale.json()).resolves.toMatchObject({ error: { code: 'STEP_UP_REQUIRED' } })
    expect(upstream).not.toHaveBeenCalled()
  })

  it('executes an approved rollback with dual-control claims and marks it executed', async () => {
    const requesterUUID = '9d2c1b3a-5e6f-4a70-8b91-fedcba987654'
    const approvalUUID = '4e8f6c91-5a7b-4c82-9d03-56789abcdef0'
    const releaseUUID = '5f9a7d02-6b8c-4d93-ae14-6789abcdef01'
    const update = vi.fn().mockResolvedValue({ id: 42 })
    const findByID = vi.fn().mockImplementation(({ collection }: { collection: string }) => {
      if (collection === 'admins') {
        return Promise.resolve({
          id: 7,
          stepUpVerifiedAt: new Date().toISOString(),
          totpEnabledAt: '2026-07-01T00:00:00.000Z',
        })
      }
      return Promise.resolve({
        approvalId: approvalUUID,
        decidedByActorId: actorUUID,
        expectedRevision: 6,
        id: 42,
        reasonCode: 'incident_rollback',
        releaseId: releaseUUID,
        requestedByActorId: requesterUUID,
        status: 'approved',
        targetReleaseRevisionId: '6a0b8e13-7c9d-4ea4-bf25-789abcdef012',
        targetVersionId: '7b1c9f24-8dae-4fb5-c036-89abcdef0123',
      })
    })
    const upstream = vi.fn().mockImplementation((request) =>
      Promise.resolve({
        data: {
          operation_id: request.idempotencyKey,
          status: 'succeeded',
          updated_at: '2026-08-04T03:00:00.000Z',
        },
      }),
    )
    const handler = createCloudHandler(upstream)

    const response = await handler(
      handlerRequest({
        body: { approval_request_id: 42 },
        findByID,
        method: 'POST',
        operation: 'rollbackOfficialRelease',
        query: `?release_id=${releaseUUID}`,
        role: 'super_admin',
        update,
      }) as never,
    )

    expect(response.status).toBe(200)
    const call = upstream.mock.calls[0][0]
    expect(call.body).toMatchObject({
      actor_admin_id: actorUUID,
      approval_id: approvalUUID,
      expected_revision: 6,
      reason_code: 'incident_rollback',
      requester_admin_id: requesterUUID,
    })
    expect(call.actor).toMatchObject({
      adminId: actorUUID,
      approvalId: approvalUUID,
      requesterAdminId: requesterUUID,
    })
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        collection: 'official-rollback-requests',
        data: expect.objectContaining({ operationId: call.idempotencyKey, status: 'executed' }),
        id: 42,
      }),
    )
  })

  it('refuses rollback execution by the requester or without approval', async () => {
    const releaseUUID = '5f9a7d02-6b8c-4d93-ae14-6789abcdef01'
    const base = {
      approvalId: '4e8f6c91-5a7b-4c82-9d03-56789abcdef0',
      expectedRevision: 6,
      id: 42,
      reasonCode: 'incident_rollback',
      releaseId: releaseUUID,
      status: 'approved',
      targetReleaseRevisionId: '6a0b8e13-7c9d-4ea4-bf25-789abcdef012',
      targetVersionId: '7b1c9f24-8dae-4fb5-c036-89abcdef0123',
    }
    const admins = {
      id: 7,
      stepUpVerifiedAt: new Date().toISOString(),
      totpEnabledAt: '2026-07-01T00:00:00.000Z',
    }
    const upstream = vi.fn()
    const handler = createCloudHandler(upstream)

    const selfExecution = await handler(
      handlerRequest({
        body: { approval_request_id: 42 },
        findByID: vi
          .fn()
          .mockImplementation(({ collection }: { collection: string }) =>
            Promise.resolve(
              collection === 'admins'
                ? admins
                : { ...base, decidedByActorId: actorUUID, requestedByActorId: actorUUID },
            ),
          ),
        method: 'POST',
        operation: 'rollbackOfficialRelease',
        query: `?release_id=${releaseUUID}`,
        role: 'super_admin',
      }) as never,
    )
    expect(selfExecution.status).toBe(403)

    const notApproved = await handler(
      handlerRequest({
        body: { approval_request_id: 42 },
        findByID: vi.fn().mockImplementation(({ collection }: { collection: string }) =>
          Promise.resolve(
            collection === 'admins'
              ? admins
              : {
                  ...base,
                  decidedByActorId: actorUUID,
                  requestedByActorId: '9d2c1b3a-5e6f-4a70-8b91-fedcba987654',
                  status: 'requested',
                },
          ),
        ),
        method: 'POST',
        operation: 'rollbackOfficialRelease',
        query: `?release_id=${releaseUUID}`,
        role: 'super_admin',
      }) as never,
    )
    expect(notApproved.status).toBe(409)
    expect(upstream).not.toHaveBeenCalled()
  })
})
