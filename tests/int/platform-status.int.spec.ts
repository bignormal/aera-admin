import { createServer, type Server } from 'node:http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { platformStatusEndpoint } from '../../src/endpoints/platform-status'

const canaryAdminKey = 'admin-canary-key-must-never-leak'

function payloadStub() {
  return {
    create: vi.fn().mockResolvedValue({ id: 1 }),
    find: vi.fn().mockResolvedValue({ docs: [] }),
    update: vi.fn().mockResolvedValue({ id: 1 }),
  }
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Test server did not bind a port')
  return `http://127.0.0.1:${address.port}`
}

async function close(server: Server | undefined): Promise<void> {
  if (!server) return
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  )
}

describe('platform status endpoint', () => {
  let server: Server | undefined
  const originalURL = process.env.AGENTERA_API_URL
  const originalKey = process.env.AGENTERA_API_ADMIN_KEY

  beforeEach(() => {
    delete process.env.AGENTERA_API_URL
    delete process.env.AGENTERA_API_ADMIN_KEY
  })

  afterEach(async () => {
    await close(server)
    server = undefined
    if (originalURL === undefined) delete process.env.AGENTERA_API_URL
    else process.env.AGENTERA_API_URL = originalURL
    if (originalKey === undefined) delete process.env.AGENTERA_API_ADMIN_KEY
    else process.env.AGENTERA_API_ADMIN_KEY = originalKey
  })

  it('returns 401 without an authenticated platform administrator', async () => {
    const response = await platformStatusEndpoint.handler({ payload: payloadStub() } as never)
    const body = await response.json()

    expect(response.status).toBe(401)
    expect(body).toMatchObject({ error: { code: 'UNAUTHENTICATED' } })
  })

  it('returns not_configured to a publisher without exposing configuration', async () => {
    const payload = payloadStub()
    const response = await platformStatusEndpoint.handler({
      headers: new Headers({ 'x-request-id': 'req_not_configured' }),
      payload,
      user: { id: 7, email: 'publisher@agentera.local', role: 'publisher' },
    } as never)
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toMatchObject({
      data: {
        agenteraAPI: { status: 'not_configured' },
        payload: { status: 'healthy' },
      },
      requestId: 'req_not_configured',
    })
    expect(JSON.stringify(body)).not.toContain('AGENTERA_API_ADMIN_KEY')
  })

  it('probes the real API compliance route with x-api-key and returns a sanitized status', async () => {
    let receivedKey: string | undefined
    let receivedPath: string | undefined
    server = createServer((request, response) => {
      receivedKey = request.headers['x-api-key'] as string | undefined
      receivedPath = request.url
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ accepted: true, secretEcho: canaryAdminKey }))
    })
    process.env.AGENTERA_API_URL = await listen(server)
    process.env.AGENTERA_API_ADMIN_KEY = canaryAdminKey
    const payload = payloadStub()

    const response = await platformStatusEndpoint.handler({
      headers: new Headers({ 'x-request-id': 'req_healthy' }),
      payload,
      user: { id: 8, email: 'publisher@agentera.local', role: 'publisher' },
    } as never)
    const text = await response.text()
    const body = JSON.parse(text) as Record<string, unknown>

    expect(response.status).toBe(200)
    expect(receivedPath).toBe('/api/v1/admin/compliance')
    expect(receivedKey).toBe(canaryAdminKey)
    expect(body).toMatchObject({ data: { agenteraAPI: { status: 'healthy' } } })
    expect(text).not.toContain(canaryAdminKey)
    expect(JSON.stringify(payload.create.mock.calls)).not.toContain(canaryAdminKey)
  })

  it('does not expose an upstream error body or admin key', async () => {
    server = createServer((_request, response) => {
      response.writeHead(500, { 'content-type': 'text/plain' })
      response.end(`upstream failed with ${canaryAdminKey}`)
    })
    process.env.AGENTERA_API_URL = await listen(server)
    process.env.AGENTERA_API_ADMIN_KEY = canaryAdminKey

    const response = await platformStatusEndpoint.handler({
      payload: payloadStub(),
      user: { id: 9, email: 'publisher@agentera.local', role: 'publisher' },
    } as never)
    const text = await response.text()

    expect(response.status).toBe(200)
    expect(text).toContain('upstream_http_500')
    expect(text).not.toContain(canaryAdminKey)
    expect(text).not.toContain('upstream failed')
  })
})
