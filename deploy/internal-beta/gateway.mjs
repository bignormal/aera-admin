#!/usr/bin/env node

import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'

const listenHost = process.env.AERA_ADMIN_GATEWAY_HOST || '0.0.0.0'
const listenPort = Number(process.env.AERA_ADMIN_GATEWAY_PORT || '8080')
const staticRoot = path.resolve(process.env.AERA_ADMIN_STATIC_ROOT || '/app/admin-web-dist')
const upstream = new URL(process.env.AERA_ADMIN_PAYLOAD_UPSTREAM || 'http://payload:3000')
const mutationsEnabled = process.env.AERA_ADMIN_MUTATIONS_ENABLED === 'true'
const healthChecksEnabled = process.env.AERA_ADMIN_HEALTH_CHECKS_ENABLED === 'true'
const maximumBodyBytes = 25 * 1024 * 1024

if (
  !Number.isInteger(listenPort) ||
  listenPort < 1 ||
  listenPort > 65535 ||
  upstream.protocol !== 'http:' ||
  upstream.username ||
  upstream.password ||
  upstream.pathname !== '/'
) {
  throw new Error('Admin gateway configuration is invalid')
}

const contentTypes = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.gif', 'image/gif'],
  ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.ttf', 'font/ttf'],
  ['.webp', 'image/webp'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
])

const hopByHopHeaders = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

function securityHeaders(response) {
  response.setHeader('X-Content-Type-Options', 'nosniff')
  response.setHeader('X-Frame-Options', 'DENY')
  response.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin')
  response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
}

function json(response, status, document) {
  const body = `${JSON.stringify(document)}\n`
  securityHeaders(response)
  response.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
    'Content-Type': 'application/json; charset=utf-8',
  })
  response.end(body)
}

function isSafeMethod(method) {
  return method === 'GET' || method === 'HEAD' || method === 'OPTIONS'
}

function isLocalSecurityLifecycle(pathname) {
  return (
    /^\/api\/admins\/(?:login|logout|refresh-token)$/u.test(pathname) ||
    pathname.startsWith('/api/security/')
  )
}

function isHealthCheckMutation(method, pathname) {
  return healthChecksEnabled && method === 'POST' && pathname === '/api/platform/v1/runtime/commands'
}

async function upstreamReady() {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 3000)
  try {
    const response = await fetch(new URL('/api/admins/me', upstream), {
      redirect: 'manual',
      signal: controller.signal,
    })
    return response.status === 200 || response.status === 401
  } catch {
    return false
  } finally {
    clearTimeout(timeout)
  }
}

function proxy(request, response, requestURL) {
  const contentLength = Number(request.headers['content-length'] || '0')
  if (!Number.isFinite(contentLength) || contentLength < 0 || contentLength > maximumBodyBytes) {
    json(response, 413, { error: { code: 'PAYLOAD_TOO_LARGE' } })
    return
  }
  if (
    !mutationsEnabled &&
    !isSafeMethod(request.method || '') &&
    !isHealthCheckMutation(request.method || '', requestURL.pathname) &&
    !isLocalSecurityLifecycle(requestURL.pathname)
  ) {
    json(response, 503, {
      error: {
        code: 'MUTATIONS_DISABLED',
        message: 'Internal Beta administration mutations are disabled.',
      },
    })
    return
  }

  const headers = {}
  for (const [name, value] of Object.entries(request.headers)) {
    if (!hopByHopHeaders.has(name.toLowerCase()) && value !== undefined) {
      headers[name] = value
    }
  }
  headers.host = upstream.host
  headers['x-forwarded-host'] = request.headers.host || ''
  headers['x-forwarded-proto'] = 'http'

  const upstreamRequest = http.request(
    {
      headers,
      hostname: upstream.hostname,
      method: request.method,
      path: `${requestURL.pathname}${requestURL.search}`,
      port: upstream.port || 80,
    },
    (upstreamResponse) => {
      const responseHeaders = {}
      for (const [name, value] of Object.entries(upstreamResponse.headers)) {
        if (!hopByHopHeaders.has(name.toLowerCase()) && value !== undefined) {
          responseHeaders[name] = value
        }
      }
      securityHeaders(response)
      response.writeHead(upstreamResponse.statusCode || 502, responseHeaders)
      upstreamResponse.pipe(response)
    },
  )
  upstreamRequest.setTimeout(65_000, () => upstreamRequest.destroy(new Error('upstream timeout')))
  upstreamRequest.on('error', () => {
    if (!response.headersSent) {
      json(response, 502, { error: { code: 'PAYLOAD_UNAVAILABLE' } })
    } else {
      response.destroy()
    }
  })
  request.pipe(upstreamRequest)
}

function safeStaticPath(pathname) {
  let decoded
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return undefined
  }
  const relative = decoded.replace(/^\/admin\/?/u, '')
  const candidate = path.resolve(staticRoot, relative || 'index.html')
  if (candidate !== staticRoot && !candidate.startsWith(`${staticRoot}${path.sep}`)) {
    return undefined
  }
  return candidate
}

async function serveStatic(request, response, requestURL) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    json(response, 405, { error: { code: 'METHOD_NOT_ALLOWED' } })
    return
  }
  const requested = safeStaticPath(requestURL.pathname)
  if (!requested) {
    json(response, 400, { error: { code: 'INVALID_PATH' } })
    return
  }

  let file = requested
  let metadata
  try {
    metadata = await stat(file)
    if (metadata.isDirectory()) {
      file = path.join(file, 'index.html')
      metadata = await stat(file)
    }
  } catch {
    if (requestURL.pathname.startsWith('/admin/assets/')) {
      json(response, 404, { error: { code: 'NOT_FOUND' } })
      return
    }
    file = path.join(staticRoot, 'index.html')
    try {
      metadata = await stat(file)
    } catch {
      json(response, 503, { error: { code: 'ADMIN_ASSETS_UNAVAILABLE' } })
      return
    }
  }
  if (!metadata.isFile()) {
    json(response, 404, { error: { code: 'NOT_FOUND' } })
    return
  }

  const immutable = requestURL.pathname.startsWith('/admin/assets/')
  securityHeaders(response)
  response.writeHead(200, {
    'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-store',
    'Content-Length': metadata.size,
    'Content-Type': contentTypes.get(path.extname(file).toLowerCase()) || 'application/octet-stream',
  })
  if (request.method === 'HEAD') {
    response.end()
    return
  }
  createReadStream(file)
    .on('error', () => response.destroy())
    .pipe(response)
}

const server = http.createServer(async (request, response) => {
  const requestURL = new URL(request.url || '/', 'http://admin.internal')
  if (requestURL.pathname === '/health/live') {
    json(response, 200, { service: 'aera-admin-gateway', status: 'ok' })
    return
  }
  if (requestURL.pathname === '/health/ready') {
    const ready = await upstreamReady()
    json(response, ready ? 200 : 503, {
      healthChecksEnabled,
      mutationsEnabled,
      service: 'aera-admin',
      status: ready ? 'ok' : 'unavailable',
    })
    return
  }
  if (requestURL.pathname === '/admin') {
    securityHeaders(response)
    response.writeHead(308, { Location: '/admin/' })
    response.end()
    return
  }
  if (requestURL.pathname.startsWith('/admin/')) {
    await serveStatic(request, response, requestURL)
    return
  }
  if (requestURL.pathname === '/api' || requestURL.pathname.startsWith('/api/')) {
    proxy(request, response, requestURL)
    return
  }
  json(response, 404, { error: { code: 'NOT_FOUND' } })
})

server.requestTimeout = 70_000
server.headersTimeout = 15_000
server.listen(listenPort, listenHost)

function shutdown() {
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(1), 10_000).unref()
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
