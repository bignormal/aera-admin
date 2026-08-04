import { randomUUID } from 'node:crypto'
import type {
  CollectionAfterChangeHook,
  CollectionAfterDeleteHook,
  CollectionAfterLoginHook,
  CollectionAfterLogoutHook,
  CollectionBeforeChangeHook,
  PayloadRequest,
} from 'payload'

import { type AdminRole, type Capability, isAdminRole } from '../access/capabilities'

const sensitiveKey =
  /(?:password|secret|token|api[_-]?key|authorization|cookie|credential|private[_-]?key)/i
const maxAuditDepth = 8
const maxAuditArrayLength = 100
const adminPasswordChangeContextKey = 'agenteraAuditAdminPasswordChange'

type AuditJSONValue = boolean | null | number | Record<string, unknown> | string | unknown[]

type AuditActor = {
  email?: string
  id: number | string
  role: AdminRole
}

export type AuditEvent = {
  action: string
  actor?: AuditActor
  after?: unknown
  before?: unknown
  capability: Capability
  errorCode?: string
  operationId?: string
  outcome: 'succeeded' | 'failed'
  requestId?: string
  resourceId?: string
  resourceName?: string
  resourceType: string
  upstreamRequestId?: string
}

function redactValue(value: unknown, seen: WeakSet<object>, depth: number): AuditJSONValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value
  if (typeof value === 'string') return value
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'undefined') return null
  if (value instanceof Date) return value.toISOString()
  if (Buffer.isBuffer(value)) return '[BINARY]'
  if (depth >= maxAuditDepth) return '[MAX_DEPTH]'

  if (Array.isArray(value)) {
    return value.slice(0, maxAuditArrayLength).map((item) => redactValue(item, seen, depth + 1))
  }

  if (typeof value === 'object') {
    if (seen.has(value)) return '[CIRCULAR]'
    seen.add(value)

    const output: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) {
      output[key] = sensitiveKey.test(key) ? '[REDACTED]' : redactValue(item, seen, depth + 1)
    }
    return output
  }

  return String(value)
}

export function redactAuditValue(value: unknown): AuditJSONValue {
  return redactValue(value, new WeakSet<object>(), 0)
}

function actorFromRequest(req: PayloadRequest): AuditActor | undefined {
  const user = req.user
  if (!user || !isAdminRole(user.role)) return undefined

  return {
    email: typeof user.email === 'string' ? user.email : undefined,
    id: user.id,
    role: user.role,
  }
}

function header(req: PayloadRequest, name: string): string | undefined {
  const value = req.headers?.get(name)?.trim()
  return value || undefined
}

function requestIP(req: PayloadRequest): string | undefined {
  const forwarded = header(req, 'x-forwarded-for')
  return forwarded?.split(',')[0]?.trim() || header(req, 'x-real-ip')
}

export async function appendAuditLog(req: PayloadRequest, event: AuditEvent): Promise<void> {
  const actor = event.actor ?? actorFromRequest(req)
  if (!actor) return

  await req.payload.create({
    collection: 'audit-logs',
    data: {
      action: event.action,
      actorEmail: actor.email,
      actorId: String(actor.id),
      actorRole: actor.role,
      after: event.after === undefined ? undefined : redactAuditValue(event.after),
      before: event.before === undefined ? undefined : redactAuditValue(event.before),
      capability: event.capability,
      errorCode: event.errorCode,
      ip: requestIP(req),
      occurredAt: new Date().toISOString(),
      outcome: event.outcome,
      operationId: event.operationId,
      requestId: event.requestId ?? header(req, 'x-request-id') ?? randomUUID(),
      resourceId: event.resourceId,
      resourceName: event.resourceName,
      resourceType: event.resourceType,
      upstreamRequestId: event.upstreamRequestId,
      userAgent: header(req, 'user-agent'),
    },
    overrideAccess: true,
    req,
  })
}

type AuditHookOptions = {
  capability: Capability
  resourceType: string
}

function resourceName(doc: Record<string, unknown>): string | undefined {
  for (const key of ['name', 'displayName', 'email', 'key', 'slug']) {
    if (typeof doc[key] === 'string' && doc[key]) return doc[key]
  }
  return undefined
}

export function createAuditHooks({ capability, resourceType }: AuditHookOptions): {
  afterChange: CollectionAfterChangeHook
  afterDelete: CollectionAfterDeleteHook
} {
  const afterChange: CollectionAfterChangeHook = async ({
    context,
    data,
    doc,
    operation,
    previousDoc,
    req,
  }) => {
    if (!actorFromRequest(req)) return doc

    const passwordChange =
      resourceType === 'admins' &&
      operation === 'update' &&
      context[adminPasswordChangeContextKey] === true
    await appendAuditLog(req, {
      action: passwordChange ? 'admins.password.change' : `${resourceType}.${operation}`,
      after: data,
      before: operation === 'update' ? previousDoc : undefined,
      capability,
      outcome: 'succeeded',
      resourceId: String(doc.id),
      resourceName: resourceName(doc),
      resourceType,
    })
    return doc
  }

  const afterDelete: CollectionAfterDeleteHook = async ({ doc, id, req }) => {
    if (!actorFromRequest(req)) return doc

    await appendAuditLog(req, {
      action: `${resourceType}.delete`,
      before: doc,
      capability,
      outcome: 'succeeded',
      resourceId: String(id),
      resourceName: resourceName(doc),
      resourceType,
    })
    return doc
  }

  return { afterChange, afterDelete }
}

export const markAdminPasswordChange: CollectionBeforeChangeHook = ({
  context,
  data,
  operation,
}) => {
  if (operation === 'update' && typeof data.password === 'string' && data.password.length > 0) {
    context[adminPasswordChangeContextKey] = true
  }
  return data
}

export const auditAdminLogin: CollectionAfterLoginHook = async ({ req, user }) => {
  if (!isAdminRole(user.role)) return

  await appendAuditLog(req, {
    action: 'auth.login',
    actor: {
      email: typeof user.email === 'string' ? user.email : undefined,
      id: user.id,
      role: user.role,
    },
    capability: 'auth:session',
    outcome: 'succeeded',
    resourceId: String(user.id),
    resourceName: typeof user.email === 'string' ? user.email : undefined,
    resourceType: 'admins',
  })
}

export const auditAdminLogout: CollectionAfterLogoutHook = async ({ req }) => {
  const actor = actorFromRequest(req)
  if (!actor) return

  await appendAuditLog(req, {
    action: 'auth.logout',
    actor,
    capability: 'auth:session',
    outcome: 'succeeded',
    resourceId: String(actor.id),
    resourceName: actor.email,
    resourceType: 'admins',
  })
}
