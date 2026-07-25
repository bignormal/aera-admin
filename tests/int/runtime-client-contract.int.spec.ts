import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  createRuntimeCommandHandler,
  createRuntimeEnrollmentHandler,
  enrollRuntimeHandler,
  runtimeCommandResultHandler,
  runtimeHeartbeatHandler,
} from '../../src/endpoints/runtime-control'
import { parseHeartbeatInput } from '../../src/domain/runtime-control-service'
import { getTestPayload } from '../helpers/payload'

// 本套件依赖旧工作区的 hermes-studio 与 agentera-claw-runtime 真实客户端；
// 在不包含这两个仓的工作区（如 aera 工作区）自动跳过。
const studioSummaryModule = resolve(
  process.cwd(),
  '../hermes-studio/packages/server/src/services/platform-control-summary.ts',
)
const runtimeRoot = resolve(process.cwd(), '../agentera-claw-runtime')
const externalClientsAvailable =
  existsSync(studioSummaryModule) && existsSync(resolve(runtimeRoot, '.venv/bin/python'))

type StudioSummaryModule = {
  buildPlatformControlSummary: (input: Record<string, unknown>) => Record<string, unknown>
  buildPlatformHealthResult: () => Record<string, unknown>
}

type ClientFixture = {
  health: Record<string, unknown>
  instanceType: 'runtime' | 'studio'
  summary: Record<string, unknown>
}

function runtimeFixture(): ClientFixture {
  const output = execFileSync(
    resolve(runtimeRoot, '.venv/bin/python'),
    [
      '-c',
      [
        'import json',
        'from hermes_cli.platform_control_summary import build_health_check_result, build_platform_control_summary',
        "resources={'tasks':[{'id':'task-1','status':'running','prompt':'private'}], 'workflows':[], 'cron':[], 'codingAgents':[], 'devices':[]}",
        "print(json.dumps({'summary':build_platform_control_summary(config={}, resources=resources), 'health':build_health_check_result()}))",
      ].join(';'),
    ],
    { cwd: runtimeRoot, encoding: 'utf8' },
  )
  const parsed = JSON.parse(output) as Pick<ClientFixture, 'health' | 'summary'>
  return { ...parsed, instanceType: 'runtime' }
}

async function studioFixture(): Promise<ClientFixture> {
  const studio = (await import(studioSummaryModule)) as StudioSummaryModule
  return {
    health: studio.buildPlatformHealthResult(),
    instanceType: 'studio',
    summary: studio.buildPlatformControlSummary({
      resources: {
        tasks: [{ id: 'task-2', prompt: 'private', status: 'running' }],
      },
    }),
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

async function clearRuntimeData() {
  const payload = await getTestPayload()
  for (const collection of ['runtime-events', 'runtime-commands', 'runtime-instances'] as const) {
    await payload.delete({ collection, overrideAccess: true, where: { id: { exists: true } } })
  }
}

async function verifyClient(fixture: ClientFixture, index: number) {
  const payload = await getTestPayload()
  expect(parseHeartbeatInput(fixture.summary)).toBeDefined()
  expect(JSON.stringify(fixture.summary)).not.toMatch(/private|prompt|conversation|deviceSecret/i)

  const enrollmentReq = request({
    body: { instanceType: fixture.instanceType, name: `${fixture.instanceType}-${index}` },
    user: { id: 1, role: 'super_admin' },
  })
  enrollmentReq.payload = payload as never
  const enrollmentResponse = await createRuntimeEnrollmentHandler(enrollmentReq as never)
  expect(enrollmentResponse.status).toBe(200)
  const enrollment = (await enrollmentResponse.json()).data

  const enrollReq = request({
    body: {
      arch: fixture.summary.arch,
      capabilities: fixture.summary.capabilities,
      deviceId: `${fixture.instanceType}-device-${index}`,
      enrollmentCode: enrollment.enrollmentCode,
      instanceType: fixture.instanceType,
      os: fixture.summary.os,
      version: fixture.summary.version,
    },
  })
  enrollReq.payload = payload as never
  const enrolledResponse = await enrollRuntimeHandler(enrollReq as never)
  expect(enrolledResponse.status).toBe(200)
  const enrolled = (await enrolledResponse.json()).data
  const headers = {
    authorization: `Bearer ${enrolled.deviceSecret}`,
    'x-agentera-instance-id': enrolled.instanceId,
  }

  const heartbeatReq = request({ body: fixture.summary, headers })
  heartbeatReq.payload = payload as never
  expect((await runtimeHeartbeatHandler(heartbeatReq as never)).status).toBe(200)

  const commandReq = request({
    body: {
      idempotencyKey: `${fixture.instanceType}-${index}`,
      instanceId: enrolled.instanceId,
      type: 'health_check',
    },
    user: { id: 1, role: 'super_admin' },
  })
  commandReq.payload = payload as never
  expect((await createRuntimeCommandHandler(commandReq as never)).status).toBe(200)

  const claimedResponse = await runtimeHeartbeatHandler(heartbeatReq as never)
  const command = (await claimedResponse.json()).data.command
  expect(command).toMatchObject({ type: 'health_check' })

  const resultReq = request({
    body: { code: 'HEALTHY', state: 'succeeded', summary: fixture.health },
    headers,
    routeParams: { id: command.id },
  })
  resultReq.payload = payload as never
  expect((await runtimeCommandResultHandler(resultReq as never)).status).toBe(200)

  const stored = await payload.findByID({
    collection: 'runtime-instances',
    id: enrolled.instanceId,
    overrideAccess: true,
  })
  expect(stored.status).toBe('online')
  expect(JSON.stringify(stored)).not.toMatch(/private|prompt|conversation/i)
}

describe.skipIf(!externalClientsAvailable)('real Runtime and Studio platform-control clients', () => {
  afterEach(clearRuntimeData)

  it('uses one strict outbound heartbeat and health-check contract for both clients', async () => {
    const fixtures = [runtimeFixture(), await studioFixture()]
    for (const [index, fixture] of fixtures.entries()) await verifyClient(fixture, index)
  })
})
