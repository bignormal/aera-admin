import { afterEach, describe, expect, it } from 'vitest'

import {
  createRuntimeCommandHandler,
  createRuntimeEnrollmentHandler,
  enrollRuntimeHandler,
  runtimeCommandResultHandler,
  runtimeHeartbeatHandler,
} from '../../src/endpoints/runtime-control'
import { hashControlSecret } from '../../src/domain/runtime-control'
import { getTestPayload } from '../helpers/payload'

async function clearRuntimeData() {
  const payload = await getTestPayload()
  for (const collection of ['runtime-events', 'runtime-commands', 'runtime-instances'] as const) {
    await payload.delete({ collection, overrideAccess: true, where: { id: { exists: true } } })
  }
}

function request(options: {
  body?: unknown
  headers?: Record<string, string>
  routeParams?: Record<string, string>
  user?: { id: number; role: string }
}) {
  return {
    headers: new Headers(options.headers),
    json: async () => options.body,
    payload: undefined,
    routeParams: options.routeParams,
    url: 'http://localhost/api/control/v1/test',
    user: options.user,
  }
}

async function enrollment() {
  const payload = await getTestPayload()
  const req = request({
    body: { instanceType: 'runtime', name: 'Runtime E2E' },
    user: { id: 1, role: 'super_admin' },
  })
  req.payload = payload as never
  const response = await createRuntimeEnrollmentHandler(req as never)
  expect(response.status).toBe(200)
  return (await response.json()).data as {
    enrollmentCode: string
    expiresAt: string
    instanceId: string
  }
}

describe('runtime control endpoints', () => {
  afterEach(clearRuntimeData)

  it('uses a one-time enrollment code and stores only secret hashes', async () => {
    const payload = await getTestPayload()
    const created = await enrollment()
    const before = await payload.findByID({
      collection: 'runtime-instances',
      id: created.instanceId,
      overrideAccess: true,
    })
    expect(before.enrollmentCodeHash).toBe(hashControlSecret(created.enrollmentCode))
    expect(JSON.stringify(before)).not.toContain(created.enrollmentCode)

    const enrollReq = request({
      body: {
        arch: 'arm64',
        capabilities: ['diagnostics.health.read'],
        deviceId: 'device-1',
        enrollmentCode: created.enrollmentCode,
        instanceType: 'runtime',
        os: 'darwin',
        version: '1.0.0',
      },
    })
    enrollReq.payload = payload as never
    const enrolled = await enrollRuntimeHandler(enrollReq as never)
    expect(enrolled.status).toBe(200)
    const body = await enrolled.json()
    expect(body.data.deviceSecret).toMatch(/^[A-Za-z0-9_-]{40,}$/)

    const stored = await payload.findByID({
      collection: 'runtime-instances',
      id: created.instanceId,
      overrideAccess: true,
    })
    expect(stored.deviceSecretHash).toBe(hashControlSecret(body.data.deviceSecret))
    expect(stored.enrollmentCodeHash).toBeNull()
    expect(JSON.stringify(stored)).not.toContain(body.data.deviceSecret)

    const replay = await enrollRuntimeHandler(enrollReq as never)
    expect(replay.status).toBe(401)
  })

  it('authenticates heartbeats, rejects sensitive content and updates only the device instance', async () => {
    const payload = await getTestPayload()
    const created = await enrollment()
    const enrollReq = request({
      body: {
        arch: 'arm64',
        capabilities: ['diagnostics.health.read'],
        deviceId: 'device-2',
        enrollmentCode: created.enrollmentCode,
        instanceType: 'runtime',
        os: 'darwin',
        version: '1.0.0',
      },
    })
    enrollReq.payload = payload as never
    const enrolled = await enrollRuntimeHandler(enrollReq as never)
    const secret = (await enrolled.json()).data.deviceSecret as string
    const heartbeat = {
      arch: 'arm64',
      capabilities: ['diagnostics.health.read'],
      channels: [{ configured: true, healthy: true, type: 'openai' }],
      metrics: { activeTasks: 1 },
      os: 'darwin',
      resources: {
        codingAgents: [{ id: 'agent-1', status: 'running', workspaceHash: 'anonymous-1' }],
        cron: [],
        devices: [],
        tasks: [{ id: 'task-1', status: 'running', tokens: 100 }],
        workflows: [],
      },
      uptimeSeconds: 20,
      version: '1.0.0',
    }

    const wrongReq = request({
      body: heartbeat,
      headers: { authorization: 'Bearer wrong', 'x-agentera-instance-id': created.instanceId },
    })
    wrongReq.payload = payload as never
    expect((await runtimeHeartbeatHandler(wrongReq as never)).status).toBe(401)

    const sensitiveReq = request({
      body: { ...heartbeat, prompt: 'private prompt' },
      headers: { authorization: `Bearer ${secret}`, 'x-agentera-instance-id': created.instanceId },
    })
    sensitiveReq.payload = payload as never
    expect((await runtimeHeartbeatHandler(sensitiveReq as never)).status).toBe(400)

    const heartbeatReq = request({
      body: heartbeat,
      headers: { authorization: `Bearer ${secret}`, 'x-agentera-instance-id': created.instanceId },
    })
    heartbeatReq.payload = payload as never
    const accepted = await runtimeHeartbeatHandler(heartbeatReq as never)
    expect(accepted.status).toBe(200)
    expect(await accepted.json()).toMatchObject({ data: { command: null, nextHeartbeatSeconds: 60 } })
    const stored = await payload.findByID({
      collection: 'runtime-instances',
      id: created.instanceId,
      overrideAccess: true,
    })
    expect(stored.status).toBe('online')
    expect(stored.healthSummary).toMatchObject({ uptimeSeconds: 20 })
    expect(stored.resources).toMatchObject({
      codingAgents: [{ workspaceHash: 'anonymous-1' }],
      tasks: [{ tokens: 100 }],
    })
  })

  it('queues a supported command, claims it once and accepts its sanitized result', async () => {
    const payload = await getTestPayload()
    const created = await enrollment()
    const enrollReq = request({
      body: {
        arch: 'arm64',
        capabilities: ['diagnostics.health.read'],
        deviceId: 'device-3',
        enrollmentCode: created.enrollmentCode,
        instanceType: 'runtime',
        os: 'darwin',
        version: '1.0.0',
      },
    })
    enrollReq.payload = payload as never
    const secret = (await (await enrollRuntimeHandler(enrollReq as never)).json()).data.deviceSecret

    const commandReq = request({
      body: { idempotencyKey: 'health-1', instanceId: created.instanceId, type: 'health_check' },
      user: { id: 1, role: 'super_admin' },
    })
    commandReq.payload = payload as never
    const queued = await createRuntimeCommandHandler(commandReq as never)
    expect(queued.status).toBe(200)

    const heartbeatReq = request({
      body: {
        arch: 'arm64',
        capabilities: ['diagnostics.health.read'],
        channels: [],
        metrics: {},
        os: 'darwin',
        resources: { codingAgents: [], cron: [], devices: [], tasks: [], workflows: [] },
        uptimeSeconds: 30,
        version: '1.0.0',
      },
      headers: { authorization: `Bearer ${secret}`, 'x-agentera-instance-id': created.instanceId },
    })
    heartbeatReq.payload = payload as never
    const first = await (await runtimeHeartbeatHandler(heartbeatReq as never)).json()
    expect(first.data.command).toMatchObject({ type: 'health_check' })
    expect((await (await runtimeHeartbeatHandler(heartbeatReq as never)).json()).data.command).toBeNull()

    const resultReq = request({
      body: { code: 'HEALTHY', state: 'succeeded', summary: { gateway: 'healthy', logs: 'must reject' } },
      headers: { authorization: `Bearer ${secret}`, 'x-agentera-instance-id': created.instanceId },
      routeParams: { id: String(first.data.command.id) },
    })
    resultReq.payload = payload as never
    expect((await runtimeCommandResultHandler(resultReq as never)).status).toBe(400)

    resultReq.json = async () => ({ code: 'HEALTHY', state: 'succeeded', summary: { gateway: 'healthy' } })
    expect((await runtimeCommandResultHandler(resultReq as never)).status).toBe(200)
  })
})
