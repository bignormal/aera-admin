import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import http from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'

const projectRoot = path.resolve(import.meta.dirname, '..', '..')
const gatewayScript = path.join(projectRoot, 'deploy', 'internal-beta', 'gateway.mjs')
const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'aera-admin-gateway-'))
const staticRoot = path.join(temporaryRoot, 'static')
let upstream
let gateway
let upstreamPort
let gatewayPort

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      resolve(server.address().port)
    })
  })
}

async function waitReady(origin) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`${origin}/health/ready`)
      if (response.status === 200) return
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('gateway did not become ready')
}

before(async () => {
  await mkdir(path.join(staticRoot, 'assets'), { recursive: true })
  await writeFile(
    path.join(staticRoot, 'index.html'),
    '<!doctype html><title>Aera 管理系统</title><div id="app"></div>',
  )
  await writeFile(path.join(staticRoot, 'assets', 'app.js'), 'window.__ADMIN__=true\n')

  upstream = http.createServer(async (request, response) => {
    if (request.url === '/api/admins/me') {
      response.writeHead(401, { 'Content-Type': 'application/json' })
      response.end('{"error":"unauthenticated"}\n')
      return
    }
    let body = ''
    for await (const chunk of request) body += chunk
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ body, method: request.method, url: request.url }))
  })
  upstreamPort = await listen(upstream)

  const reservation = http.createServer()
  gatewayPort = await listen(reservation)
  await new Promise((resolve) => reservation.close(resolve))
  gateway = spawn(process.execPath, [gatewayScript], {
    env: {
      ...process.env,
      AERA_ADMIN_GATEWAY_HOST: '127.0.0.1',
      AERA_ADMIN_GATEWAY_PORT: String(gatewayPort),
      AERA_ADMIN_MUTATIONS_ENABLED: 'false',
      AERA_ADMIN_PAYLOAD_UPSTREAM: `http://127.0.0.1:${upstreamPort}`,
      AERA_ADMIN_STATIC_ROOT: staticRoot,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  await waitReady(`http://127.0.0.1:${gatewayPort}`)
})

after(async () => {
  gateway?.kill('SIGTERM')
  await new Promise((resolve) => upstream?.close(resolve))
  await rm(temporaryRoot, { recursive: true, force: true })
})

test('serves Soybean only under /admin with bounded cache policy', async () => {
  const origin = `http://127.0.0.1:${gatewayPort}`
  const redirect = await fetch(`${origin}/admin`, { redirect: 'manual' })
  assert.equal(redirect.status, 308)
  assert.equal(redirect.headers.get('location'), '/admin/')
  const index = await fetch(`${origin}/admin/deep/link`)
  assert.equal(index.status, 200)
  assert.match(await index.text(), /Aera 管理系统/u)
  assert.equal(index.headers.get('cache-control'), 'no-store')
  const asset = await fetch(`${origin}/admin/assets/app.js`)
  assert.equal(asset.status, 200)
  assert.equal(asset.headers.get('cache-control'), 'public, max-age=31536000, immutable')
})

test('proxies reads and local auth but blocks business mutations by default', async () => {
  const origin = `http://127.0.0.1:${gatewayPort}`
  const read = await fetch(`${origin}/api/platform/v1/listUsers`)
  assert.equal(read.status, 200)
  const blocked = await fetch(`${origin}/api/platform/v1/createUser`, {
    body: '{}',
    headers: { 'Content-Type': 'application/json' },
    method: 'POST',
  })
  assert.equal(blocked.status, 503)
  assert.equal((await blocked.json()).error.code, 'MUTATIONS_DISABLED')
  const login = await fetch(`${origin}/api/admins/login`, {
    body: '{}',
    headers: { 'Content-Type': 'application/json' },
    method: 'POST',
  })
  assert.equal(login.status, 200)
})

test('reports Payload-aware readiness and hides all unrelated routes', async () => {
  const origin = `http://127.0.0.1:${gatewayPort}`
  const ready = await fetch(`${origin}/health/ready`)
  assert.deepEqual(await ready.json(), {
    mutationsEnabled: false,
    service: 'aera-admin',
    status: 'ok',
  })
  assert.equal((await fetch(`${origin}/`)).status, 404)
  assert.equal((await fetch(`${origin}/admin/assets/missing.js`)).status, 404)
})
