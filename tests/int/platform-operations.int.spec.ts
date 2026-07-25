import { describe, expect, it } from 'vitest'

import { sanitizeDiagnostic } from '../../src/platform-api/operations-adapter'
import { platformOperations, type PlatformOperation } from '../../src/platform-api/operations'

const registry = platformOperations as Record<string, PlatformOperation>

describe('platform operational operations', () => {
  it('uses write capabilities for every operational mutation', () => {
    const scoped = Object.entries(registry).filter(([, definition]) =>
      definition.upstreamPath(Object.fromEntries((definition.params || []).map((name) => [name, `:${name}`]))).match(
        /^\/admin\/(ops|risk-control|usage|backups|data-management|settings|system)/,
      ),
    )
    expect(scoped.length).toBeGreaterThan(20)
    for (const [name, definition] of scoped) {
      if (definition.method === 'GET') continue
      expect(
        ['operations:write', 'system:write', 'system:backup:restore'],
        `${name} has a safe mutation capability`,
      ).toContain(definition.capability)
    }
  })

  it('locks restore and admin-key regeneration behind reauthentication', () => {
    expect(registry.restoreBackup).toMatchObject({
      capability: 'system:backup:restore',
      requiresReauthentication: true,
      risk: 'high',
    })
    expect(registry.regenerateAdminAPIKey).toMatchObject({
      capability: 'system:write',
      requiresReauthentication: true,
      risk: 'high',
    })
  })

  it('never registers websocket proxy paths', () => {
    for (const definition of Object.values(registry)) {
      const params = Object.fromEntries((definition.params || []).map((name) => [name, `:${name}`]))
      expect(definition.upstreamPath(params)).not.toContain('/ws/')
    }
  })

  it('sanitizes diagnostics down to structured metadata', () => {
    const result = sanitizeDiagnostic({
      request_id: 'request-1',
      created_at: '2026-07-16T00:00:00Z',
      model: 'gpt-5',
      channel: 'openai',
      status: 'failed',
      latency_ms: 412,
      error_code: 'UPSTREAM_429',
      error_message: 'rate limited token=secret',
      request_body: { prompt: 'private prompt' },
      response_body: 'private response',
      headers: { authorization: 'Bearer secret' },
      cookie: 'session=secret',
    })

    expect(result).toEqual({
      requestId: 'request-1',
      occurredAt: '2026-07-16T00:00:00Z',
      model: 'gpt-5',
      channel: 'openai',
      status: 'failed',
      latencyMs: 412,
      errorCode: 'UPSTREAM_429',
      errorSummary: 'rate limited [REDACTED]',
    })
    expect(JSON.stringify(result)).not.toContain('private prompt')
    expect(JSON.stringify(result)).not.toContain('Bearer')
  })
})
