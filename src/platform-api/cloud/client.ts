import { readFileSync } from 'node:fs'
import type { KeyObject } from 'node:crypto'
import { Agent, fetch as undiciFetch, type Dispatcher } from 'undici'

import { PlatformAPIError } from '../client'
import { redactExternalData } from '../redaction'
import type { ServiceProbe } from '../types'
import { type CloudAdminConfig, readCloudAdminConfig } from './config'
import {
  type CloudActorContext,
  createTokenSource,
  parseEd25519PrivateKey,
  type TokenSource,
} from './token'

const probeTimeoutMilliseconds = 3_000
const retriableStatuses = new Set([502, 503, 504])
const basePath = '/internal/admin/v1'

export type CloudUpstreamRequest = {
  actor?: CloudActorContext
  body?: unknown
  idempotencyKey?: string
  method: 'DELETE' | 'GET' | 'PATCH' | 'POST' | 'PUT'
  path: string
  query?: URLSearchParams
  requestId: string
  signal?: AbortSignal
}

type CloudTransport = {
  config: CloudAdminConfig
  dispatcher: Dispatcher
  tokenSource: TokenSource
}

type TransportCache = {
  fingerprint: string
  transport: CloudTransport
}

let cachedTransport: TransportCache | undefined

function transportFingerprint(config: CloudAdminConfig): string {
  return JSON.stringify([
    config.baseURL.toString(),
    config.caFile,
    config.clientCertFile,
    config.clientKeyFile,
    config.jwtSigningKeyFile,
    config.jwtIssuer,
    config.jwtSubject,
    config.scopes,
  ])
}

function loadTransport(config: CloudAdminConfig, requestId: string): CloudTransport {
  const fingerprint = transportFingerprint(config)
  if (cachedTransport?.fingerprint === fingerprint) return cachedTransport.transport

  let ca: string
  let cert: string
  let key: string
  let privateKey: KeyObject
  try {
    ca = readFileSync(config.caFile, 'utf8')
    cert = readFileSync(config.clientCertFile, 'utf8')
    key = readFileSync(config.clientKeyFile, 'utf8')
    privateKey = parseEd25519PrivateKey(readFileSync(config.jwtSigningKeyFile, 'utf8'))
  } catch {
    throw new PlatformAPIError('CLOUD_UPSTREAM_MISCONFIGURED', 503, requestId)
  }

  const transport: CloudTransport = {
    config,
    dispatcher: new Agent({
      connect: {
        ca,
        cert,
        key,
        maxVersion: 'TLSv1.3',
        minVersion: 'TLSv1.3',
      },
    }),
    tokenSource: createTokenSource({
      issuer: config.jwtIssuer,
      privateKey,
      scopes: config.scopes,
      subject: config.jwtSubject,
    }),
  }
  cachedTransport = { fingerprint, transport }
  return transport
}

export function resetCloudTransportForTests(): void {
  cachedTransport = undefined
}

function upstreamURL(baseURL: URL, request: CloudUpstreamRequest): URL {
  if (!request.path.startsWith('/') || request.path.includes('..')) {
    throw new PlatformAPIError('UPSTREAM_PATH_REJECTED', 500, request.requestId)
  }
  const url = new URL(`${basePath}${request.path}`, baseURL)
  if (request.query) url.search = request.query.toString()
  return url
}

async function fetchCloudUpstream<T>(request: CloudUpstreamRequest): Promise<{
  data: T
  upstreamRequestId?: string
}> {
  const config = readCloudAdminConfig()
  if (!config.configured) {
    throw new PlatformAPIError('UPSTREAM_NOT_CONFIGURED', 503, request.requestId)
  }
  const transport = loadTransport(config, request.requestId)

  let token: string
  try {
    token = transport.tokenSource.token(request.actor)
  } catch {
    throw new PlatformAPIError('CLOUD_ACTOR_INVALID', 500, request.requestId)
  }

  const timeoutSignal = AbortSignal.timeout(config.timeoutMs)
  const signal = request.signal ? AbortSignal.any([request.signal, timeoutSignal]) : timeoutSignal
  const headers: Record<string, string> = {
    accept: 'application/json',
    authorization: `Bearer ${token}`,
    'x-request-id': request.requestId,
  }
  if (request.body !== undefined) headers['content-type'] = 'application/json'
  if (request.idempotencyKey) headers['idempotency-key'] = request.idempotencyKey

  let response: Awaited<ReturnType<typeof undiciFetch>>
  try {
    response = await undiciFetch(upstreamURL(config.baseURL, request), {
      body: request.body === undefined ? undefined : JSON.stringify(request.body),
      dispatcher: transport.dispatcher,
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
    let upstreamCode: string | undefined
    try {
      const failure = (await response.json()) as { error?: { code?: string } }
      if (typeof failure?.error?.code === 'string') upstreamCode = failure.error.code
    } catch {
      // 非 JSON 错误体按通用 HTTP 错误处理。
    }
    throw new PlatformAPIError(
      upstreamCode || 'UPSTREAM_HTTP_ERROR',
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

export async function requestCloudUpstream<T>(request: CloudUpstreamRequest): Promise<{
  data: T
  upstreamRequestId?: string
}> {
  const maxAttempts = request.method === 'GET' ? 2 : 1
  let lastError: unknown

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await fetchCloudUpstream<T>(request)
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

export async function probeCloudAdmin(requestId: string): Promise<ServiceProbe> {
  const checkedAt = new Date().toISOString()
  const config = readCloudAdminConfig()
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
    const transport = loadTransport(config, requestId)
    const response = await undiciFetch(new URL(`${basePath}/health`, config.baseURL), {
      dispatcher: transport.dispatcher,
      headers: {
        authorization: `Bearer ${transport.tokenSource.token()}`,
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
