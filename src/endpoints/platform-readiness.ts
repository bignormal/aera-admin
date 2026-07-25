import { randomUUID } from 'node:crypto'
import type { Endpoint } from 'payload'

import { PlatformAPIError, requestUpstream, type UpstreamRequest } from '../platform-api/client'
import { platformOperations } from '../platform-api/operations'
import { platformReadProbes } from '../platform-api/read-probes'

type ReadinessUpstream = (
  request: UpstreamRequest,
) => Promise<{ data: unknown; upstreamRequestId?: string }>

type DomainReadiness = {
  errorCode?: string
  key: string
  label: string
  latencyMs: number
  status: 'healthy' | 'unavailable'
}

function requestID(headers?: Headers): string {
  return headers?.get('x-request-id')?.trim() || randomUUID()
}

function failure(requestId: string, status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message }, requestId }, { status })
}

function elapsedMilliseconds(startedAt: number): number {
  return Math.max(0, Math.round(performance.now() - startedAt))
}

function normalizedErrorCode(error: unknown): string {
  return error instanceof PlatformAPIError ? error.code.toLowerCase() : 'probe_failed'
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function validateProbeResponse(
  value: unknown,
  shape: 'array' | 'page' | 'record',
  requestId: string,
): void {
  if (!record(value) || value.code !== 0 || !('data' in value)) {
    throw new PlatformAPIError('UPSTREAM_INVALID_RESPONSE', 502, requestId)
  }
  const valid =
    shape === 'array'
      ? Array.isArray(value.data)
      : shape === 'page'
        ? record(value.data) && Array.isArray(value.data.items)
        : record(value.data)
  if (!valid) throw new PlatformAPIError('UPSTREAM_INVALID_RESPONSE', 502, requestId)
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  limit: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length)
  let nextIndex = 0
  const workers = Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex
      nextIndex += 1
      results[index] = await mapper(values[index] as T)
    }
  })
  await Promise.all(workers)
  return results
}

export function createPlatformReadinessHandler(
  upstream: ReadinessUpstream = requestUpstream,
): Endpoint['handler'] {
  return async (req) => {
    const currentRequestID = requestID(req.headers)
    if (!req.user) {
      return failure(currentRequestID, 401, 'UNAUTHENTICATED', '请先登录管理后台。')
    }
    if (req.user.role !== 'super_admin') {
      return failure(currentRequestID, 403, 'FORBIDDEN', '仅超级管理员可验证真实资源。')
    }

    const domains = await mapWithConcurrency(
      platformReadProbes,
      4,
      async (probe): Promise<DomainReadiness> => {
        const operation = platformOperations[probe.operation]
        const startedAt = performance.now()
        const probeRequestID = `${currentRequestID}-${probe.key}`
        try {
          const result = await upstream({
            method: 'GET',
            path: operation.upstreamPath({}),
            query: new URLSearchParams(probe.query),
            requestId: probeRequestID,
          })
          validateProbeResponse(result.data, probe.shape, probeRequestID)
          return {
            key: probe.key,
            label: probe.label,
            latencyMs: elapsedMilliseconds(startedAt),
            status: 'healthy',
          }
        } catch (error) {
          return {
            errorCode: normalizedErrorCode(error),
            key: probe.key,
            label: probe.label,
            latencyMs: elapsedMilliseconds(startedAt),
            status: 'unavailable',
          }
        }
      },
    )

    return Response.json({
      data: { domains },
      meta: { generatedAt: new Date().toISOString() },
      requestId: currentRequestID,
    })
  }
}

export const platformReadinessEndpoint: Endpoint = {
  path: '/platform/v1/readiness',
  method: 'get',
  handler: createPlatformReadinessHandler(),
}
