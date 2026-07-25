import { describe, expect, it } from 'vitest'

import { requestUpstream } from '../../src/platform-api/client'
import { platformOperations } from '../../src/platform-api/operations'
import { platformReadProbes } from '../../src/platform-api/read-probes'

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

describe('live AgentEra API read contracts', () => {
  for (const probe of platformReadProbes) {
    it(`${probe.key} returns the real success envelope and expected shape`, async () => {
      const operation = platformOperations[probe.operation]
      const result = await requestUpstream<unknown>({
        method: 'GET',
        path: operation.upstreamPath({}),
        query: new URLSearchParams(probe.query),
        requestId: `live-${probe.key}`,
      })

      expect(record(result.data)).toBe(true)
      const envelope = result.data as Record<string, unknown>
      expect(envelope.code).toBe(0)
      expect(envelope).toHaveProperty('data')

      if (probe.shape === 'array') {
        expect(Array.isArray(envelope.data)).toBe(true)
      } else if (probe.shape === 'page') {
        expect(record(envelope.data)).toBe(true)
        expect(Array.isArray((envelope.data as Record<string, unknown>).items)).toBe(true)
      } else {
        expect(record(envelope.data)).toBe(true)
      }
    })
  }
})
