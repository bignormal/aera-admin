import { describe, expect, it } from 'vitest'

import { platformOperations } from '../../src/platform-api/operations'
import { platformReadProbes } from '../../src/platform-api/read-probes'

describe('platform real-read probe catalog', () => {
  it('covers every real administration read domain with a registered GET operation', () => {
    expect(platformReadProbes.map((probe) => probe.key)).toEqual([
      'users',
      'accounts',
      'groups',
      'proxies',
      'channels',
      'billing',
      'orders',
      'subscriptions',
      'operations',
      'alerts',
      'risk',
      'usage',
      'system',
    ])

    for (const probe of platformReadProbes) {
      const operation = platformOperations[probe.operation]
      expect(operation).toBeDefined()
      expect(operation.method).toBe('GET')
      expect(operation.mutation).toBe(false)
      expect(operation.params || []).toEqual([])
      expect(operation.upstreamPath({})).toMatch(/^\/admin\//)
    }

    expect(platformReadProbes.find((probe) => probe.key === 'alerts')).toMatchObject({
      query: { limit: '1' },
      shape: 'array',
    })
  })
})
