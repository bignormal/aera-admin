import { readAgenteraAPIConfig } from './config'
import { redactExternalData } from './redaction'
import type { ServiceProbe } from './types'

const probeTimeoutMilliseconds = 3_000
const retriableStatuses = new Set([502, 503, 504])

export type UpstreamRequest = {
  body?: unknown
  idempotencyKey?: string
  method: 'DELETE' | 'GET' | 'POST' | 'PUT'
  path: string
  query?: URLSearchParams
  requestId: string
  signal?: AbortSignal
}

export class PlatformAPIError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    public readonly requestId: string,
    public readonly upstreamRequestId?: string,
  ) {
    super(code)
    this.name = 'PlatformAPIError'
  }
}

function upstreamURL(baseURL: URL, request: UpstreamRequest): URL {
  if (!/^\/admin(?:\/|$)/.test(request.path) || request.path.includes('..')) {
    throw new PlatformAPIError('UPSTREAM_PATH_REJECTED', 500, request.requestId)
  }
  const url = new URL(`/api/v1${request.path}`, baseURL)
  if (request.query) url.search = request.query.toString()
  return url
}

async function fetchUpstream<T>(request: UpstreamRequest): Promise<{
  data: T
  upstreamRequestId?: string
}> {
  const config = readAgenteraAPIConfig()
  if (!config.configured) {
    throw new PlatformAPIError('UPSTREAM_NOT_CONFIGURED', 503, request.requestId)
  }

  const timeoutSignal = AbortSignal.timeout(config.timeoutMs)
  const signal = request.signal ? AbortSignal.any([request.signal, timeoutSignal]) : timeoutSignal
  const headers = new Headers({
    accept: 'application/json',
    'x-api-key': config.adminKey,
    'x-request-id': request.requestId,
  })
  if (request.body !== undefined) headers.set('content-type', 'application/json')
  if (request.idempotencyKey) headers.set('idempotency-key', request.idempotencyKey)

  let response: Response
  try {
    response = await fetch(upstreamURL(config.baseURL, request), {
      body: request.body === undefined ? undefined : JSON.stringify(request.body),
      headers,
      method: request.method,
      redirect: 'error',
      signal,
    })
  } catch {
    if (timeoutSignal.aborted) {
      throw new PlatformAPIError('UPSTREAM_TIMEOUT', 504, request.requestId)
    }
    if (request.signal?.aborted) {
      throw new PlatformAPIError('UPSTREAM_ABORTED', 499, request.requestId)
    }
    throw new PlatformAPIError('UPSTREAM_NETWORK_ERROR', 503, request.requestId)
  }

  const upstreamRequestId = response.headers.get('x-request-id')?.trim() || undefined
  if (!response.ok) {
    await response.body?.cancel()
    throw new PlatformAPIError(
      'UPSTREAM_HTTP_ERROR',
      response.status,
      request.requestId,
      upstreamRequestId,
    )
  }

  if (response.status === 204) {
    return { data: undefined as T, upstreamRequestId }
  }
  const contentType = response.headers.get('content-type') || ''
  if (!contentType.includes('application/json')) {
    await response.body?.cancel()
    throw new PlatformAPIError(
      'UPSTREAM_INVALID_RESPONSE',
      502,
      request.requestId,
      upstreamRequestId,
    )
  }

  let data: unknown
  try {
    data = await response.json()
  } catch {
    throw new PlatformAPIError(
      'UPSTREAM_INVALID_RESPONSE',
      502,
      request.requestId,
      upstreamRequestId,
    )
  }
  return { data: redactExternalData(data) as T, upstreamRequestId }
}

export async function requestUpstream<T>(request: UpstreamRequest): Promise<{
  data: T
  upstreamRequestId?: string
}> {
  const maxAttempts = request.method === 'GET' ? 2 : 1
  let lastError: unknown

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await fetchUpstream<T>(request)
    } catch (error) {
      lastError = error
      const retryable =
        error instanceof PlatformAPIError &&
        (error.code === 'UPSTREAM_NETWORK_ERROR' ||
          error.code === 'UPSTREAM_TIMEOUT' ||
          (error.code === 'UPSTREAM_HTTP_ERROR' && retriableStatuses.has(error.status)))
      if (!retryable || attempt === maxAttempts) throw error
    }
  }

  throw lastError
}

function elapsedMilliseconds(startedAt: number): number {
  return Math.max(0, Math.round(performance.now() - startedAt))
}

export async function probeAgenteraAPI(requestId: string): Promise<ServiceProbe> {
  const checkedAt = new Date().toISOString()
  const config = readAgenteraAPIConfig()
  if (!config.configured) {
    return {
      checkedAt,
      errorCode: config.errorCode,
      latencyMs: 0,
      status: 'not_configured',
    }
  }

  const startedAt = performance.now()
  try {
    const response = await fetch(new URL('/api/v1/admin/compliance', config.baseURL), {
      headers: {
        'x-api-key': config.adminKey,
        'x-request-id': requestId,
      },
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(probeTimeoutMilliseconds),
    })
    await response.body?.cancel()

    if (response.ok) {
      return {
        checkedAt,
        latencyMs: elapsedMilliseconds(startedAt),
        status: 'healthy',
      }
    }

    return {
      checkedAt,
      errorCode: `upstream_http_${response.status}`,
      latencyMs: elapsedMilliseconds(startedAt),
      status: 'unavailable',
    }
  } catch (error) {
    const timedOut = error instanceof DOMException && error.name === 'TimeoutError'
    return {
      checkedAt,
      errorCode: timedOut ? 'upstream_timeout' : 'upstream_network_error',
      latencyMs: elapsedMilliseconds(startedAt),
      status: 'unavailable',
    }
  }
}
