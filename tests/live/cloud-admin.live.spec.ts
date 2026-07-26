import { describe, expect, it } from 'vitest'

import { probeCloudAdmin, requestCloudUpstream } from '../../src/platform-api/cloud/client'
import { cloudOperations } from '../../src/platform-api/cloud/operations'

const readActor = {
  adminId: '00000000-0000-4000-8000-000000000001',
  role: 'super_admin' as const,
}

function nonNegativeInteger(value: unknown): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

describe('live Aera Cloud admin contracts', () => {
  it('proves the mTLS and service-JWT health path', async () => {
    const probe = await probeCloudAdmin('live-cloud-health')

    expect(probe).toMatchObject({ status: 'healthy' })
    expect(probe.errorCode).toBeUndefined()
  })

  it('reads real privacy-safe platform counters', async () => {
    const result = await requestCloudUpstream<Record<string, unknown>>({
      method: 'GET',
      path: cloudOperations.cloudStats.upstreamPath({}),
      requestId: 'live-cloud-stats',
    })

    for (const field of [
      'user_total',
      'user_active',
      'user_disabled',
      'user_pending_deletion',
      'device_total',
      'device_active',
    ]) {
      expect(nonNegativeInteger(result.data[field]), field).toBe(true)
    }
  })

  it('reads the real platform-owned official Agent catalog without mutation', async () => {
    const result = await requestCloudUpstream<{ items?: unknown }>({
      actor: readActor,
      method: 'GET',
      path: cloudOperations.listOfficialDefinitions.upstreamPath({}),
      query: new URLSearchParams({ limit: '20' }),
      requestId: 'live-cloud-official-definitions',
    })

    expect(Array.isArray(result.data.items)).toBe(true)
  })
})
