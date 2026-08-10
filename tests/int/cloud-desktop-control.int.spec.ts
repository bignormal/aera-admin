import { describe, expect, it, vi } from 'vitest'

import { PlatformAPIError } from '../../src/platform-api/client'
import { createCloudHandler } from '../../src/platform-api/cloud/handler'

const adminID = '7f3e9a10-6b2c-4d8e-9f01-abcdef012345'
const deviceID = '8a4fab21-7c3d-4e9f-a012-bcdef1234567'
const userID = '9b50bc32-8d4e-5fa0-b123-cdef23456789'
const commandID = 'ac61cd43-9e5f-60b1-c234-def3456789ab'

type RequestOptions = {
  body?: unknown
  idempotencyKey?: string
  method?: string
  operation: string
  query?: string
  role?: string
}

function request(options: RequestOptions) {
  const headers = new Headers({ 'x-request-id': 'desktop-bff-request' })
  if (options.idempotencyKey) headers.set('idempotency-key', options.idempotencyKey)
  return {
    headers,
    json: vi.fn().mockResolvedValue(options.body),
    method: options.method || 'GET',
    payload: {
      create: vi.fn().mockResolvedValue({ id: 1 }),
      find: vi.fn().mockResolvedValue({ docs: [] }),
      findByID: vi.fn().mockResolvedValue({ id: 1 }),
      update: vi.fn().mockResolvedValue({ id: 1 }),
    },
    routeParams: { operation: options.operation },
    url: `http://localhost/api/cloud/v1/${options.operation}${options.query || ''}`,
    user: options.role
      ? { cloudActorId: adminID, email: 'ops@agentera.local', id: 7, role: options.role }
      : undefined,
  }
}

function desktop(status: 'online' | 'offline') {
  return {
    arch: 'arm64',
    capabilities: ['diagnostics.health.read'],
    client_version: '1.0.0',
    created_at: '2026-08-11T00:00:00.000Z',
    device_id: deviceID,
    display_name: status === 'online' ? 'Fleet Mac' : 'Fleet Mac Offline',
    effective_status: status,
    health_status: status === 'online' ? 'healthy' : 'unknown',
    last_heartbeat_at: '2026-08-11T00:00:00.000Z',
    platform: 'darwin',
    updated_at: '2026-08-11T00:00:00.000Z',
    user_id: userID,
  }
}

describe('Cloud Desktop control BFF integration', () => {
  it('forwards bounded list filters and preserves Cloud-computed online states', async () => {
    const upstream = vi.fn().mockResolvedValue({
      data: {
        items: [desktop('online'), { ...desktop('offline'), device_id: adminID }],
        server_time: '2026-08-11T00:00:00.000Z',
        total: 2,
      },
      upstreamRequestId: 'cloud-desktop-list',
    })
    const response = await createCloudHandler(upstream)(
      request({
        operation: 'listDesktopControlInstances',
        query: `?effective_status=online&limit=10&offset=0&user_id=${userID}`,
        role: 'operations_admin',
      }) as never,
    )

    expect(response.status).toBe(200)
    expect(upstream).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'GET',
        path: '/desktop-control/instances',
        requiredScope: 'desktop_control:read',
      }),
    )
    expect(upstream.mock.calls[0][0].query.toString()).toBe(
      `effective_status=online&limit=10&offset=0&user_id=${userID}`,
    )
    await expect(response.json()).resolves.toMatchObject({
      data: {
        items: [
          { device_id: deviceID, effective_status: 'online' },
          { device_id: adminID, effective_status: 'offline' },
        ],
        total: 2,
      },
      meta: { upstreamRequestId: 'cloud-desktop-list' },
      requestId: 'desktop-bff-request',
    })
  })

  it.each(['queued', 'claimed', 'running', 'succeeded', 'failed', 'expired'] as const)(
    'returns the %s command state only from the point lookup endpoint',
    async (state) => {
      const upstream = vi.fn().mockResolvedValue({
        data: {
          command_id: commandID,
          created_at: '2026-08-11T00:00:00.000Z',
          created_by_admin_id: adminID,
          device_id: deviceID,
          expires_at: '2026-08-11T00:10:00.000Z',
          request_id: 'cloud-command-request',
          required_capability: 'diagnostics.health.read',
          server_time: '2026-08-11T00:00:01.000Z',
          state,
          type: 'health_check',
          updated_at: '2026-08-11T00:00:01.000Z',
        },
      })
      const response = await createCloudHandler(upstream)(
        request({
          operation: 'getDesktopControlCommand',
          query: `?command_id=${commandID}`,
          role: 'auditor',
        }) as never,
      )

      expect(response.status).toBe(200)
      expect(upstream.mock.calls[0][0]).toMatchObject({
        path: `/desktop-control/commands/${commandID}`,
        requiredScope: 'desktop_control:read',
      })
      await expect(response.json()).resolves.toMatchObject({ data: { command_id: commandID, state } })
    },
  )

  it('binds health_check to the authenticated operator and caller idempotency key', async () => {
    const upstream = vi.fn().mockResolvedValue({
      data: {
        command_id: commandID,
        created_at: '2026-08-11T00:00:00.000Z',
        created_by_admin_id: adminID,
        device_id: deviceID,
        expires_at: '2026-08-11T00:10:00.000Z',
        request_id: 'cloud-command-request',
        required_capability: 'diagnostics.health.read',
        server_time: '2026-08-11T00:00:00.000Z',
        state: 'queued',
        type: 'health_check',
        updated_at: '2026-08-11T00:00:00.000Z',
      },
    })
    const response = await createCloudHandler(upstream)(
      request({
        body: {},
        idempotencyKey: 'desktop-health-e2e',
        method: 'POST',
        operation: 'createDesktopHealthCheck',
        query: `?device_id=${deviceID}`,
        role: 'operations_admin',
      }) as never,
    )

    expect(response.status).toBe(200)
    expect(upstream).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: { adminId: adminID, role: 'operator' },
        body: {},
        idempotencyKey: 'desktop-health-e2e',
        path: `/desktop-control/instances/${deviceID}/health-check`,
        requiredScope: 'desktop_control:command',
      }),
    )
  })

  it('fails closed for missing capability and preserves the local request ID on outage', async () => {
    const deniedUpstream = vi.fn()
    const denied = await createCloudHandler(deniedUpstream)(
      request({ operation: 'listDesktopControlInstances', role: 'publisher' }) as never,
    )
    expect(denied.status).toBe(403)
    expect(deniedUpstream).not.toHaveBeenCalled()

    const unavailableUpstream = vi
      .fn()
      .mockRejectedValue(
        new PlatformAPIError('UPSTREAM_NETWORK_ERROR', 503, 'desktop-bff-request', 'cloud-outage'),
      )
    const unavailable = await createCloudHandler(unavailableUpstream)(
      request({ operation: 'getDesktopControlInstance', query: `?device_id=${deviceID}`, role: 'auditor' }) as never,
    )
    expect(unavailable.status).toBe(503)
    await expect(unavailable.json()).resolves.toEqual({
      error: {
        code: 'UPSTREAM_NETWORK_ERROR',
        message: 'Aera Cloud 管理服务暂时无法完成该操作。',
      },
      requestId: 'desktop-bff-request',
    })
  })
})
