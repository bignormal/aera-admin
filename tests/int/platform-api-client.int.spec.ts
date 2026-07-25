import { createServer, type Server } from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { PlatformAPIError, requestUpstream } from '../../src/platform-api/client'
import { getPlatformAPIConfig } from '../../src/platform-api/config'
import { redactExternalData } from '../../src/platform-api/redaction'

const canaryAdminKey = 'admin-secret-value'

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Test server did not bind')
  return `http://127.0.0.1:${address.port}`
}

async function close(server: Server | undefined): Promise<void> {
  if (!server) return
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  )
}

describe('platform API upstream client', () => {
  let server: Server | undefined
  const originalEnv = {
    key: process.env.AGENTERA_API_ADMIN_KEY,
    timeout: process.env.AGENTERA_API_TIMEOUT_MS,
    url: process.env.AGENTERA_API_URL,
  }

  beforeEach(() => {
    delete process.env.AGENTERA_API_ADMIN_KEY
    delete process.env.AGENTERA_API_TIMEOUT_MS
    delete process.env.AGENTERA_API_URL
  })

  afterEach(async () => {
    await close(server)
    server = undefined
    for (const [name, value] of [
      ['AGENTERA_API_ADMIN_KEY', originalEnv.key],
      ['AGENTERA_API_TIMEOUT_MS', originalEnv.timeout],
      ['AGENTERA_API_URL', originalEnv.url],
    ] as const) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  })

  it('validates configuration without returning a secret for invalid input', () => {
    expect(getPlatformAPIConfig({})).toEqual({
      configured: false,
      errorCode: 'missing_configuration',
    })
    expect(
      getPlatformAPIConfig({
        AGENTERA_API_ADMIN_KEY: canaryAdminKey,
        AGENTERA_API_URL: 'file:///tmp/api',
      }),
    ).toEqual({ configured: false, errorCode: 'invalid_url' })
  })

  it('retries one read-only 503, forwards request metadata and redacts output', async () => {
    let requests = 0
    let receivedKey: string | undefined
    let receivedRequestID: string | undefined
    server = createServer((request, response) => {
      requests += 1
      receivedKey = request.headers['x-api-key'] as string | undefined
      receivedRequestID = request.headers['x-request-id'] as string | undefined
      if (requests === 1) {
        response.writeHead(503, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: canaryAdminKey }))
        return
      }
      response.writeHead(200, {
        'content-type': 'application/json',
        'x-request-id': 'upstream-request-7',
      })
      response.end(
        JSON.stringify({ data: { access_token: canaryAdminKey, email: 'a@example.com' } }),
      )
    })
    process.env.AGENTERA_API_URL = await listen(server)
    process.env.AGENTERA_API_ADMIN_KEY = canaryAdminKey

    const result = await requestUpstream<{ data: Record<string, unknown> }>({
      method: 'GET',
      path: '/admin/users',
      query: new URLSearchParams({ page: '1' }),
      requestId: 'platform-request-7',
    })

    expect(requests).toBe(2)
    expect(receivedKey).toBe(canaryAdminKey)
    expect(receivedRequestID).toBe('platform-request-7')
    expect(result.upstreamRequestId).toBe('upstream-request-7')
    expect(result.data).toEqual({
      data: { access_token: '[REDACTED]', email: 'a@example.com' },
    })
    expect(JSON.stringify(result)).not.toContain(canaryAdminKey)
  })

  it('never retries mutations and never includes the upstream body or key in errors', async () => {
    let requests = 0
    server = createServer((_request, response) => {
      requests += 1
      response.writeHead(503, { 'content-type': 'text/plain' })
      response.end(`failed with ${canaryAdminKey}`)
    })
    process.env.AGENTERA_API_URL = await listen(server)
    process.env.AGENTERA_API_ADMIN_KEY = canaryAdminKey

    let error: unknown
    try {
      await requestUpstream({
        body: { name: 'example' },
        method: 'POST',
        path: '/admin/users',
        requestId: 'platform-request-post',
      })
    } catch (caught) {
      error = caught
    }

    expect(requests).toBe(1)
    expect(error).toBeInstanceOf(PlatformAPIError)
    expect(error).toMatchObject({ code: 'UPSTREAM_HTTP_ERROR', status: 503 })
    expect(JSON.stringify(error)).not.toContain(canaryAdminKey)
    expect(String(error)).not.toContain('failed with')
  })

  it('maps an abort timeout to a stable sanitized error', async () => {
    server = createServer(() => undefined)
    process.env.AGENTERA_API_URL = await listen(server)
    process.env.AGENTERA_API_ADMIN_KEY = canaryAdminKey
    process.env.AGENTERA_API_TIMEOUT_MS = '20'

    await expect(
      requestUpstream({ method: 'GET', path: '/admin/users', requestId: 'timeout-request' }),
    ).rejects.toMatchObject({ code: 'UPSTREAM_TIMEOUT', status: 504 })
  })

  it('recursively redacts credential-shaped fields without hiding normal data', () => {
    expect(
      redactExternalData({
        access_token: 'abc',
        email: 'a@example.com',
        nested: { client_secret: 'def', items: [{ proxy_password: 'ghi' }] },
      }),
    ).toEqual({
      access_token: '[REDACTED]',
      email: 'a@example.com',
      nested: { client_secret: '[REDACTED]', items: [{ proxy_password: '[REDACTED]' }] },
    })
  })
})
