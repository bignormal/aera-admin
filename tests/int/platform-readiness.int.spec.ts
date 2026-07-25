import { describe, expect, it, vi } from 'vitest'

import { createPlatformReadinessHandler } from '../../src/endpoints/platform-readiness'
import { PlatformAPIError } from '../../src/platform-api/client'
import { platformOperations } from '../../src/platform-api/operations'
import { platformReadProbes } from '../../src/platform-api/read-probes'

const canarySecret = 'admin-readiness-key-must-never-leak'

function request(role?: string) {
  return {
    headers: new Headers({ 'x-request-id': 'readiness-request' }),
    user: role ? { id: 1, email: 'admin@agentera.local', role } : undefined,
  } as never
}

function validProbeResponse(path: string, item: Record<string, unknown> = { id: 1 }) {
  const probe = platformReadProbes.find(
    (candidate) => platformOperations[candidate.operation].upstreamPath({}) === path,
  )
  if (!probe) throw new Error(`Unknown probe path: ${path}`)
  const data = probe.shape === 'array' ? [item] : probe.shape === 'page' ? { items: [item] } : {}
  return { data: { code: 0, data, message: 'success' } }
}

describe('platform domain readiness endpoint', () => {
  it('requires a super administrator', async () => {
    const handler = createPlatformReadinessHandler(vi.fn())

    await expect(handler(request())).resolves.toMatchObject({ status: 401 })
    await expect(handler(request('publisher'))).resolves.toMatchObject({ status: 403 })
  })

  it('reports every domain without sampled data or excessive concurrency', async () => {
    let active = 0
    let maxActive = 0
    const upstream = vi.fn(async (upstreamRequest: { path: string }) => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise((resolve) => setTimeout(resolve, 2))
      active -= 1
      return validProbeResponse(upstreamRequest.path, {
        email: 'private@example.com',
        id: 1,
        secret: canarySecret,
      })
    })
    const response = await createPlatformReadinessHandler(upstream)(request('super_admin'))
    const text = await response.text()
    const body = JSON.parse(text)

    expect(response.status).toBe(200)
    expect(body.data.domains).toHaveLength(13)
    expect(
      body.data.domains.every((domain: { status: string }) => domain.status === 'healthy'),
    ).toBe(true)
    expect(maxActive).toBeLessThanOrEqual(4)
    expect(text).not.toContain('private@example.com')
    expect(text).not.toContain(canarySecret)
  })

  it('keeps healthy domains visible when one probe fails', async () => {
    const upstream = vi.fn(async (upstreamRequest: { path: string; requestId: string }) => {
      if (upstreamRequest.path === '/admin/channels') {
        throw new PlatformAPIError('UPSTREAM_HTTP_ERROR', 503, upstreamRequest.requestId)
      }
      return validProbeResponse(upstreamRequest.path)
    })
    const response = await createPlatformReadinessHandler(upstream)(request('super_admin'))
    const body = await response.json()
    const channels = body.data.domains.find((domain: { key: string }) => domain.key === 'channels')

    expect(response.status).toBe(200)
    expect(channels).toMatchObject({ errorCode: 'upstream_http_error', status: 'unavailable' })
    expect(
      body.data.domains.filter((domain: { status: string }) => domain.status === 'healthy'),
    ).toHaveLength(12)
  })

  it('marks a malformed successful payload unavailable', async () => {
    const upstream = vi.fn(async (upstreamRequest: { path: string }) => {
      if (upstreamRequest.path === '/admin/users') {
        return { data: { code: 0, data: { items: 'invalid' }, message: 'success' } }
      }
      return validProbeResponse(upstreamRequest.path)
    })
    const response = await createPlatformReadinessHandler(upstream)(request('super_admin'))
    const body = await response.json()
    const users = body.data.domains.find((domain: { key: string }) => domain.key === 'users')

    expect(users).toMatchObject({ errorCode: 'upstream_invalid_response', status: 'unavailable' })
  })
})
