import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import type { Payload, PayloadRequest } from 'payload'

import type { RuntimeCommand, RuntimeInstance } from '../payload-types'
import {
  canTransitionCommand,
  hashControlSecret,
  runtimeCommandKey,
  type RuntimeCommandState,
  type RuntimeCommandType,
} from './runtime-control'

const heartbeatSeconds = 60
const maximumItems = 100
const maximumBodyBytes = 256 * 1024
const forbiddenKey = /(?:chat|conversation|message|memory|file|workspace|prompt|reply|patch|terminal|environment|log|config|secret|token|password|authorization|cookie|credential)/i

type RuntimeInstanceType = 'desktop' | 'runtime' | 'studio'

export type EnrollmentInput = {
  instanceType: RuntimeInstanceType
  name: string
  tenantId?: string
}

export type DeviceEnrollmentInput = {
  arch: string
  capabilities: string[]
  deviceId: string
  enrollmentCode: string
  instanceType: RuntimeInstanceType
  os: string
  version: string
}

export type HeartbeatInput = {
  arch: string
  capabilities: string[]
  channels: Array<{ configured: boolean; errorCode?: string; healthy?: boolean; type: string }>
  metrics: Record<string, number>
  os: string
  resources: {
    codingAgents: Array<Record<string, unknown>>
    cron: Array<Record<string, unknown>>
    devices: Array<Record<string, unknown>>
    tasks: Array<Record<string, unknown>>
    workflows: Array<Record<string, unknown>>
  }
  uptimeSeconds: number
  version: string
}

const resourceFields = {
  codingAgents: ['id', 'type', 'status', 'durationMs', 'changeCount', 'workspaceHash'],
  cron: ['id', 'status', 'nextRunAt', 'lastResult'],
  devices: ['id', 'type', 'status', 'lastSeenAt'],
  tasks: ['id', 'status', 'source', 'model', 'tokens', 'cost', 'errorCode'],
  workflows: ['id', 'status', 'version', 'nodeCount', 'failedNode'],
} as const

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key))
}

function shortText(value: unknown, maximum = 200): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maximum
}

function validCapabilities(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= 50 &&
    value.every((item) => shortText(item, 100) && !forbiddenKey.test(item))
  )
}

function bodyWithinLimit(value: unknown): boolean {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8') <= maximumBodyBytes
  } catch {
    return false
  }
}

export function parseEnrollmentInput(value: unknown): EnrollmentInput | undefined {
  if (!record(value) || !exactKeys(value, ['instanceType', 'name', 'tenantId'])) return undefined
  if (!['desktop', 'runtime', 'studio'].includes(String(value.instanceType))) return undefined
  if (!shortText(value.name, 120)) return undefined
  if (value.tenantId !== undefined && !shortText(value.tenantId, 120)) return undefined
  return value as EnrollmentInput
}

export function parseDeviceEnrollmentInput(value: unknown): DeviceEnrollmentInput | undefined {
  const keys = ['arch', 'capabilities', 'deviceId', 'enrollmentCode', 'instanceType', 'os', 'version']
  if (!record(value) || !exactKeys(value, keys) || !bodyWithinLimit(value)) return undefined
  if (!['desktop', 'runtime', 'studio'].includes(String(value.instanceType))) return undefined
  if (
    !shortText(value.arch, 80) ||
    !shortText(value.deviceId, 200) ||
    !shortText(value.enrollmentCode, 200) ||
    !shortText(value.os, 80) ||
    !shortText(value.version, 80) ||
    !validCapabilities(value.capabilities)
  ) {
    return undefined
  }
  return value as DeviceEnrollmentInput
}

function sanitizedResourceArray(
  value: unknown,
  fields: readonly string[],
): Array<Record<string, unknown>> | undefined {
  if (!Array.isArray(value) || value.length > maximumItems) return undefined
  const result: Array<Record<string, unknown>> = []
  for (const item of value) {
    if (!record(item) || !exactKeys(item, fields) || !shortText(item.id, 200) || !shortText(item.status, 80)) {
      return undefined
    }
    result.push(Object.fromEntries(Object.entries(item).filter(([, field]) => field !== undefined)))
  }
  return result
}

export function parseHeartbeatInput(value: unknown): HeartbeatInput | undefined {
  const rootKeys = ['arch', 'capabilities', 'channels', 'metrics', 'os', 'resources', 'uptimeSeconds', 'version']
  if (!record(value) || !exactKeys(value, rootKeys) || !bodyWithinLimit(value)) return undefined
  if (
    !shortText(value.arch, 80) ||
    !shortText(value.os, 80) ||
    !shortText(value.version, 80) ||
    !validCapabilities(value.capabilities) ||
    typeof value.uptimeSeconds !== 'number' ||
    !Number.isFinite(value.uptimeSeconds) ||
    value.uptimeSeconds < 0 ||
    !record(value.metrics) ||
    Object.keys(value.metrics).length > 100 ||
    Object.entries(value.metrics).some(
      ([key, metric]) => forbiddenKey.test(key) || typeof metric !== 'number' || !Number.isFinite(metric),
    )
  ) {
    return undefined
  }

  if (!Array.isArray(value.channels) || value.channels.length > maximumItems) return undefined
  const channels: HeartbeatInput['channels'] = []
  for (const channel of value.channels) {
    if (
      !record(channel) ||
      !exactKeys(channel, ['configured', 'errorCode', 'healthy', 'type']) ||
      !shortText(channel.type, 80) ||
      typeof channel.configured !== 'boolean' ||
      (channel.healthy !== undefined && typeof channel.healthy !== 'boolean') ||
      (channel.errorCode !== undefined && !shortText(channel.errorCode, 100))
    ) {
      return undefined
    }
    channels.push(channel as HeartbeatInput['channels'][number])
  }

  if (!record(value.resources) || !exactKeys(value.resources, Object.keys(resourceFields))) return undefined
  const resources = {} as HeartbeatInput['resources']
  for (const [kind, fields] of Object.entries(resourceFields)) {
    const items = sanitizedResourceArray(value.resources[kind], fields)
    if (!items) return undefined
    resources[kind as keyof HeartbeatInput['resources']] = items
  }

  return {
    arch: value.arch,
    capabilities: value.capabilities,
    channels,
    metrics: value.metrics as Record<string, number>,
    os: value.os,
    resources,
    uptimeSeconds: value.uptimeSeconds,
    version: value.version,
  }
}

function relationID(value: RuntimeCommand['instance']): number | string {
  return typeof value === 'object' ? value.id : value
}

function safeEqualHash(secret: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashControlSecret(secret), 'hex')
  const expected = Buffer.from(expectedHash, 'hex')
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

export async function createEnrollment(payload: Payload, input: EnrollmentInput) {
  const enrollmentCode = randomBytes(32).toString('base64url')
  const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString()
  const instance = await payload.create({
    collection: 'runtime-instances',
    data: {
      deviceIdHash: hashControlSecret(`pending:${randomUUID()}`),
      enrollmentCodeHash: hashControlSecret(enrollmentCode),
      enrollmentExpiresAt: expiresAt,
      instanceType: input.instanceType,
      name: input.name,
      status: 'pending',
      tenantId: input.tenantId,
    },
    overrideAccess: true,
  })
  return { enrollmentCode, expiresAt, instanceId: String(instance.id) }
}

export async function enrollDevice(payload: Payload, input: DeviceEnrollmentInput) {
  const found = await payload.find({
    collection: 'runtime-instances',
    limit: 2,
    overrideAccess: true,
    where: { enrollmentCodeHash: { equals: hashControlSecret(input.enrollmentCode) } },
  })
  const instance = found.docs[0]
  if (
    !instance ||
    instance.instanceType !== input.instanceType ||
    !instance.enrollmentExpiresAt ||
    Date.parse(instance.enrollmentExpiresAt) <= Date.now()
  ) {
    return undefined
  }

  const deviceSecret = randomBytes(32).toString('base64url')
  const updated = await payload.update({
    collection: 'runtime-instances',
    data: {
      arch: input.arch,
      capabilities: input.capabilities,
      deviceIdHash: hashControlSecret(input.deviceId),
      deviceSecretHash: hashControlSecret(deviceSecret),
      enrollmentCodeHash: null,
      enrollmentExpiresAt: null,
      os: input.os,
      status: 'offline',
      version: input.version,
    },
    id: instance.id,
    overrideAccess: true,
  })
  return { deviceSecret, heartbeatSeconds, instanceId: String(updated.id) }
}

export async function authenticateDevice(req: PayloadRequest): Promise<RuntimeInstance | undefined> {
  const instanceId = req.headers?.get('x-agentera-instance-id')?.trim()
  const authorization = req.headers?.get('authorization')?.trim() || ''
  const secret = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : ''
  if (!instanceId || !secret) return undefined
  try {
    const instance = await req.payload.findByID({
      collection: 'runtime-instances',
      id: instanceId,
      overrideAccess: true,
    })
    if (
      instance.status === 'disabled' ||
      !instance.deviceSecretHash ||
      !safeEqualHash(secret, instance.deviceSecretHash)
    ) {
      return undefined
    }
    return instance
  } catch {
    return undefined
  }
}

export async function acceptHeartbeat(payload: Payload, instance: RuntimeInstance, input: HeartbeatInput) {
  const acceptedAt = new Date().toISOString()
  await payload.update({
    collection: 'runtime-instances',
    data: {
      arch: input.arch,
      capabilities: input.capabilities,
      channels: input.channels,
      healthSummary: {
        channelCount: input.channels.length,
        metrics: input.metrics,
        resourceCounts: Object.fromEntries(
          Object.entries(input.resources).map(([key, items]) => [key, items.length]),
        ),
        uptimeSeconds: input.uptimeSeconds,
      },
      lastHeartbeatAt: acceptedAt,
      os: input.os,
      resources: input.resources,
      status: 'online',
      version: input.version,
    },
    id: instance.id,
    overrideAccess: true,
  })
  const command = await claimCommand(payload, instance.id, new Set(input.capabilities), acceptedAt)
  return {
    acceptedAt,
    command: command
      ? { id: String(command.id), type: command.type, claimedAt: command.claimedAt }
      : null,
    nextHeartbeatSeconds: heartbeatSeconds,
  }
}

async function claimCommand(
  payload: Payload,
  instanceId: number,
  capabilities: Set<string>,
  now: string,
) {
  const found = await payload.find({
    collection: 'runtime-commands',
    limit: 100,
    overrideAccess: true,
    sort: 'createdAt',
    where: {
      and: [{ instance: { equals: instanceId } }, { state: { equals: 'queued' } }],
    },
  })
  for (const command of found.docs) {
    if (command.expiresAt && Date.parse(command.expiresAt) <= Date.parse(now)) {
      await payload.update({
        collection: 'runtime-commands',
        data: { state: 'expired' },
        id: command.id,
        overrideAccess: true,
      })
      continue
    }
    if (!capabilities.has(command.requiredCapability)) continue
    return payload.update({
      collection: 'runtime-commands',
      data: { claimedAt: now, state: 'claimed' },
      id: command.id,
      overrideAccess: true,
    })
  }
  return undefined
}

const commandCapability: Record<RuntimeCommandType, string> = {
  health_check: 'diagnostics.health.read',
}

export async function queueRuntimeCommand(
  payload: Payload,
  input: { createdBy?: number; idempotencyKey: string; instanceId: number | string; type: RuntimeCommandType },
) {
  const instance = await payload.findByID({
    collection: 'runtime-instances',
    id: input.instanceId,
    overrideAccess: true,
  })
  const capabilities = Array.isArray(instance.capabilities) ? instance.capabilities : []
  const requiredCapability = commandCapability[input.type]
  if (!capabilities.includes(requiredCapability)) return { error: 'UNSUPPORTED_CAPABILITY' as const }
  const commandKey = runtimeCommandKey(instance.id, input.idempotencyKey)
  const existing = await payload.find({
    collection: 'runtime-commands',
    limit: 1,
    overrideAccess: true,
    where: { commandKey: { equals: commandKey } },
  })
  if (existing.docs[0]) return { command: existing.docs[0] }
  let createdBy: number | undefined
  if (input.createdBy !== undefined) {
    try {
      const admin = await payload.findByID({
        collection: 'admins',
        id: input.createdBy,
        overrideAccess: true,
      })
      createdBy = admin.id
    } catch {
      createdBy = undefined
    }
  }
  const command = await payload.create({
    collection: 'runtime-commands',
    data: {
      commandKey,
      createdBy,
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      idempotencyKey: input.idempotencyKey,
      instance: instance.id,
      requiredCapability,
      state: 'queued',
      type: input.type,
    },
    overrideAccess: true,
  })
  return { command }
}

function safeResultSummary(value: unknown): Record<string, unknown> | undefined {
  if (!record(value) || !bodyWithinLimit(value)) return undefined
  if (Object.keys(value).some((key) => forbiddenKey.test(key))) return undefined
  const serialized = JSON.stringify(value)
  if (forbiddenKey.test(serialized)) return undefined
  return value
}

export async function completeRuntimeCommand(
  payload: Payload,
  instance: RuntimeInstance,
  commandId: string,
  input: unknown,
) {
  if (!record(input) || !exactKeys(input, ['code', 'state', 'summary'])) return { error: 'INVALID_BODY' as const }
  if (!['running', 'succeeded', 'failed'].includes(String(input.state))) return { error: 'INVALID_BODY' as const }
  if (input.code !== undefined && !shortText(input.code, 100)) return { error: 'INVALID_BODY' as const }
  const summary = safeResultSummary(input.summary)
  if (!summary) return { error: 'INVALID_BODY' as const }
  let command: RuntimeCommand
  try {
    command = await payload.findByID({
      collection: 'runtime-commands',
      id: commandId,
      overrideAccess: true,
    })
  } catch {
    return { error: 'NOT_FOUND' as const }
  }
  if (String(relationID(command.instance)) !== String(instance.id)) return { error: 'NOT_FOUND' as const }

  const target = input.state as RuntimeCommandState
  let current = command.state
  if (current === 'claimed' && (target === 'succeeded' || target === 'failed')) {
    await payload.update({
      collection: 'runtime-commands',
      data: { startedAt: new Date().toISOString(), state: 'running' },
      id: command.id,
      overrideAccess: true,
    })
    current = 'running'
  }
  if (!canTransitionCommand(current, target)) return { error: 'INVALID_TRANSITION' as const }
  const now = new Date().toISOString()
  const updated = await payload.update({
    collection: 'runtime-commands',
    data: {
      ...(target === 'running' ? { startedAt: now } : { completedAt: now }),
      resultCode: typeof input.code === 'string' ? input.code : undefined,
      resultSummary: summary,
      state: target,
    },
    id: command.id,
    overrideAccess: true,
  })
  return { command: updated }
}
