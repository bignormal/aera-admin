import { describe, expect, it, vi } from 'vitest'

import { createPlatformHandler } from '../../src/platform-api/handler'
import { platformOperations } from '../../src/platform-api/operations'

function request(options: {
  body?: unknown
  method?: string
  operation: string
  query?: string
  role?: string
}) {
  return {
    headers: new Headers({ 'x-request-id': 'bff-request-1' }),
    json: vi.fn().mockResolvedValue(options.body),
    method: options.method || 'GET',
    payload: { create: vi.fn().mockResolvedValue({ id: 1 }) },
    routeParams: { operation: options.operation },
    url: `http://localhost/api/platform/v1/${options.operation}${options.query || ''}`,
    user: options.role
      ? { email: `${options.role}@agentera.local`, id: 7, role: options.role }
      : undefined,
  }
}

describe('allowlisted platform BFF', () => {
  it('registers actual Aera API paths, including the real scheduled-test prefix', () => {
    expect(platformOperations.listUsers.upstreamPath({})).toBe('/admin/users')
    expect(platformOperations.updateUserBalance.upstreamPath({ id: '8' })).toBe(
      '/admin/users/8/balance',
    )
    expect(platformOperations.listScheduledTests.upstreamPath({ id: '9' })).toBe(
      '/admin/accounts/9/scheduled-test-plans',
    )
    expect(platformOperations.createScheduledTest.upstreamPath({})).toBe(
      '/admin/scheduled-test-plans',
    )
    expect(platformOperations.listTLSProfiles.upstreamPath({})).toBe(
      '/admin/tls-fingerprint-profiles',
    )
    expect(platformOperations.listErrorRules.upstreamPath({})).toBe(
      '/admin/error-passthrough-rules',
    )
  })

  it('rejects anonymous, unauthorized, unknown and invalid requests before upstream', async () => {
    const upstream = vi.fn()
    const handler = createPlatformHandler(upstream)

    const anonymous = await handler(request({ operation: 'listUsers' }) as never)
    const forbidden = await handler(request({ operation: 'listUsers', role: 'publisher' }) as never)
    const unknown = await handler(
      request({ operation: 'notRegistered', role: 'super_admin' }) as never,
    )
    const invalidID = await handler(
      request({ operation: 'getUser', query: '?id=../secret', role: 'super_admin' }) as never,
    )

    expect(anonymous.status).toBe(401)
    expect(forbidden.status).toBe(403)
    expect(unknown.status).toBe(404)
    expect(invalidID.status).toBe(400)
    expect(upstream).not.toHaveBeenCalled()
  })

  it('calls an allowed read with query data and emits a fixed redacted envelope', async () => {
    const upstream = vi.fn().mockResolvedValue({
      data: { data: [{ access_token: 'must-not-leak', email: 'u@agentera.local' }] },
      upstreamRequestId: 'api-request-9',
    })
    const handler = createPlatformHandler(upstream)
    const response = await handler(
      request({
        operation: 'listUsers',
        query: '?page=2&page_size=20&search=test',
        role: 'operations_admin',
      }) as never,
    )
    const text = await response.text()
    const body = JSON.parse(text)

    expect(response.status).toBe(200)
    expect(upstream).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'GET',
        path: '/admin/users',
        query: new URLSearchParams({ page: '2', page_size: '20', search: 'test' }),
        requestId: 'bff-request-1',
      }),
    )
    expect(body).toEqual({
      data: { data: [{ access_token: '[REDACTED]', email: 'u@agentera.local' }] },
      meta: { upstreamRequestId: 'api-request-9' },
      requestId: 'bff-request-1',
    })
    expect(text).not.toContain('must-not-leak')
  })

  it('requires the registered method and audits a successful mutation', async () => {
    const upstream = vi.fn().mockResolvedValue({ data: { success: true } })
    const handler = createPlatformHandler(upstream)
    const mismatchRequest = request({
      method: 'GET',
      operation: 'updateUserBalance',
      query: '?id=8',
      role: 'operations_admin',
    })
    const mismatch = await handler(mismatchRequest as never)
    expect(mismatch.status).toBe(405)

    const mutationRequest = request({
      body: { balance: '10.00', note: '人工补偿', operation: 'add' },
      method: 'POST',
      operation: 'updateUserBalance',
      query: '?id=8',
      role: 'operations_admin',
    })
    const response = await handler(mutationRequest as never)

    expect(response.status).toBe(200)
    expect(upstream).toHaveBeenCalledWith(
      expect.objectContaining({
        body: { balance: '10.00', note: '人工补偿', operation: 'add' },
        method: 'POST',
        path: '/admin/users/8/balance',
      }),
    )
    expect(mutationRequest.payload.create).toHaveBeenCalledWith(
      expect.objectContaining({
        collection: 'audit-logs',
        data: expect.objectContaining({
          action: 'platform.updateUserBalance',
          capability: 'users:balance:update',
          outcome: 'succeeded',
          resourceId: '8',
        }),
        overrideAccess: true,
      }),
    )
  })
})
