import { createPrivateKey, type KeyObject, randomBytes, sign as signRaw } from 'node:crypto'

import { cloudAdminRoles } from '../../access/cloud-actor'

// 逐字段对齐 aera-admin/internal/cloudadmin/token.go 与
// aera-cloud/internal/adminapi/auth.go 的服务 JWT 契约：
// EdDSA(Ed25519) + aud=aera-cloud-admin + 5 分钟寿命 + 严格 claim 集合。
const serviceTokenLifetimeSeconds = 5 * 60
const notBeforeSkewSeconds = 5
const serviceJWTAudience = 'aera-cloud-admin'

const canonicalUUIDPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export type CloudActorContext = {
  adminId: string
  role: string
  operationId?: string
  approvalId?: string
  requesterAdminId?: string
}

type ServiceClaims = {
  iss: string
  sub: string
  aud: string
  scope: readonly string[]
  iat: number
  nbf: number
  exp: number
  jti: string
  admin_id?: string
  admin_role?: string
  operation_id?: string
  approval_id?: string
  requester_admin_id?: string
}

export function isCanonicalUUID(value: string): boolean {
  return canonicalUUIDPattern.test(value)
}

export function parseEd25519PrivateKey(pem: string): KeyObject {
  let key: KeyObject
  try {
    key = createPrivateKey(pem)
  } catch {
    throw new Error('service JWT signing key is invalid')
  }
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new Error('service JWT signing key must be Ed25519')
  }
  return key
}

export function validActorContext(actor: CloudActorContext | undefined): boolean {
  if (!actor) return true
  if (!isCanonicalUUID(actor.adminId)) return false
  if (!cloudAdminRoles.includes(actor.role as (typeof cloudAdminRoles)[number])) return false
  if (actor.operationId !== undefined && !isCanonicalUUID(actor.operationId)) return false
  if (actor.approvalId !== undefined && !isCanonicalUUID(actor.approvalId)) return false
  if (actor.requesterAdminId !== undefined && !isCanonicalUUID(actor.requesterAdminId)) return false
  const rollbackEvidence = actor.approvalId !== undefined || actor.requesterAdminId !== undefined
  if (rollbackEvidence) {
    return (
      actor.operationId !== undefined &&
      actor.approvalId !== undefined &&
      actor.requesterAdminId !== undefined &&
      actor.requesterAdminId !== actor.adminId
    )
  }
  return true
}

export type TokenSource = {
  token: (actor?: CloudActorContext) => string
}

export function createTokenSource(options: {
  clock?: () => Date
  issuer: string
  privateKey: KeyObject
  scopes: readonly string[]
  subject: string
}): TokenSource {
  const clock = options.clock ?? (() => new Date())
  return {
    token(actor?: CloudActorContext): string {
      if (!validActorContext(actor)) {
        throw new Error('service JWT actor context is invalid')
      }
      const now = Math.floor(clock().getTime() / 1000)
      const claims: ServiceClaims = {
        iss: options.issuer,
        sub: options.subject,
        aud: serviceJWTAudience,
        scope: [...options.scopes],
        iat: now,
        nbf: now - notBeforeSkewSeconds,
        exp: now + serviceTokenLifetimeSeconds,
        jti: randomBytes(16).toString('base64url'),
      }
      if (actor) {
        claims.admin_id = actor.adminId
        claims.admin_role = actor.role
        if (actor.operationId) claims.operation_id = actor.operationId
        if (actor.approvalId) {
          claims.approval_id = actor.approvalId
          claims.requester_admin_id = actor.requesterAdminId
        }
      }
      const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'JWT' })).toString('base64url')
      const body = Buffer.from(JSON.stringify(claims)).toString('base64url')
      const unsigned = `${header}.${body}`
      const signature = signRaw(null, Buffer.from(unsigned), options.privateKey)
      return `${unsigned}.${signature.toString('base64url')}`
    },
  }
}
