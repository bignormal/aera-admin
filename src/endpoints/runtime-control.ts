import { randomUUID } from 'node:crypto'
import type { Endpoint, PayloadHandler, PayloadRequest } from 'payload'

import { hasCapability } from '../access/capabilities'
import { appendAuditLog, type AuditEvent } from '../domain/audit'
import {
  acceptHeartbeat,
  authenticateDevice,
  completeRuntimeCommand,
  createEnrollment,
  enrollDevice,
  parseDeviceEnrollmentInput,
  parseEnrollmentInput,
  parseHeartbeatInput,
  queueRuntimeCommand,
} from '../domain/runtime-control-service'

function requestID(req: PayloadRequest): string {
  return req.headers?.get('x-request-id')?.trim() || randomUUID()
}

function success(requestId: string, data: unknown): Response {
  return Response.json({ data, meta: {}, requestId })
}

function failure(requestId: string, status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message }, requestId }, { status })
}

async function json(req: PayloadRequest): Promise<unknown> {
  try {
    return typeof req.json === 'function' ? await req.json() : undefined
  } catch {
    return undefined
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

async function auditRuntimeMutation(req: PayloadRequest, event: AuditEvent): Promise<void> {
  try {
    await appendAuditLog(req, event)
  } catch {
    // The Runtime write has already succeeded; keep its stable result if local audit persistence is unavailable.
  }
}

export const createRuntimeEnrollmentHandler: PayloadHandler = async (req) => {
  const id = requestID(req)
  if (!req.user) return failure(id, 401, 'UNAUTHENTICATED', '请先登录管理后台。')
  if (!hasCapability(req.user.role, 'runtime:command:create')) {
    return failure(id, 403, 'FORBIDDEN', '当前角色无权创建注册码。')
  }
  const input = parseEnrollmentInput(await json(req))
  if (!input) return failure(id, 400, 'INVALID_BODY', '注册信息不合法。')
  const result = await createEnrollment(req.payload, input)
  await auditRuntimeMutation(req, {
    action: 'runtime.enrollment.create',
    after: {
      expiresAt: result.expiresAt,
      instanceId: result.instanceId,
      instanceType: input.instanceType,
      name: input.name,
      tenantId: input.tenantId,
    },
    capability: 'runtime:command:create',
    outcome: 'succeeded',
    requestId: id,
    resourceId: result.instanceId,
    resourceName: input.name,
    resourceType: 'runtime-instances',
  })
  return success(id, result)
}

export const enrollRuntimeHandler: PayloadHandler = async (req) => {
  const id = requestID(req)
  const input = parseDeviceEnrollmentInput(await json(req))
  if (!input) return failure(id, 400, 'INVALID_BODY', '设备注册信息不合法。')
  const result = await enrollDevice(req.payload, input)
  if (!result) return failure(id, 401, 'INVALID_ENROLLMENT', '注册码无效、已使用或已过期。')
  return success(id, result)
}

export const runtimeHeartbeatHandler: PayloadHandler = async (req) => {
  const id = requestID(req)
  const instance = await authenticateDevice(req)
  if (!instance) return failure(id, 401, 'INVALID_DEVICE', '设备身份验证失败。')
  const input = parseHeartbeatInput(await json(req))
  if (!input) return failure(id, 400, 'INVALID_BODY', '心跳包含不允许或不合法的数据。')
  return success(id, await acceptHeartbeat(req.payload, instance, input))
}

export const createRuntimeCommandHandler: PayloadHandler = async (req) => {
  const id = requestID(req)
  if (!req.user) return failure(id, 401, 'UNAUTHENTICATED', '请先登录管理后台。')
  if (!hasCapability(req.user.role, 'runtime:command:create')) {
    return failure(id, 403, 'FORBIDDEN', '当前角色无权创建运行时命令。')
  }
  const value = await json(req)
  if (
    !record(value) ||
    !['health_check'].includes(String(value.type)) ||
    !['number', 'string'].includes(typeof value.instanceId) ||
    typeof value.idempotencyKey !== 'string' ||
    !/^[A-Za-z0-9._:-]{1,128}$/.test(value.idempotencyKey)
  ) {
    return failure(id, 400, 'INVALID_BODY', '命令信息不合法。')
  }
  const result = await queueRuntimeCommand(req.payload, {
    createdBy: Number(req.user.id),
    idempotencyKey: value.idempotencyKey,
    instanceId: value.instanceId as number | string,
    type: value.type as 'health_check',
  })
  if ('error' in result && result.error) {
    return failure(id, 409, result.error, '实例未声明该命令所需能力。')
  }
  await auditRuntimeMutation(req, {
    action: 'runtime.command.create',
    after: {
      idempotencyKey: value.idempotencyKey,
      instanceId: String(value.instanceId),
      state: result.command.state,
      type: value.type,
    },
    capability: 'runtime:command:create',
    outcome: 'succeeded',
    requestId: id,
    resourceId: String(result.command.id),
    resourceType: 'runtime-commands',
  })
  return success(id, {
    command: {
      id: String(result.command.id),
      instanceId: String(value.instanceId),
      state: result.command.state,
      type: result.command.type,
    },
  })
}

export const runtimeCommandResultHandler: PayloadHandler = async (req) => {
  const id = requestID(req)
  const instance = await authenticateDevice(req)
  if (!instance) return failure(id, 401, 'INVALID_DEVICE', '设备身份验证失败。')
  const commandId = typeof req.routeParams?.id === 'string' ? req.routeParams.id : ''
  if (!/^\d+$/.test(commandId)) return failure(id, 400, 'INVALID_COMMAND_ID', '命令编号不合法。')
  const result = await completeRuntimeCommand(req.payload, instance, commandId, await json(req))
  if ('error' in result && result.error) {
    const status = result.error === 'NOT_FOUND' ? 404 : 400
    return failure(id, status, result.error, '命令结果不合法。')
  }
  return success(id, { command: result.command })
}

export const runtimeControlEndpoints: Endpoint[] = [
  {
    path: '/platform/v1/runtime/enrollments',
    method: 'post',
    handler: createRuntimeEnrollmentHandler,
  },
  { path: '/platform/v1/runtime/commands', method: 'post', handler: createRuntimeCommandHandler },
  { path: '/control/v1/enroll', method: 'post', handler: enrollRuntimeHandler },
  { path: '/control/v1/heartbeat', method: 'post', handler: runtimeHeartbeatHandler },
  { path: '/control/v1/commands/:id/result', method: 'post', handler: runtimeCommandResultHandler },
]
