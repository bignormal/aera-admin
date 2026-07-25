import type { Access, PayloadRequest } from 'payload'

import { type Capability, hasCapability } from './capabilities'

export type { AdminRole } from './capabilities'

type RequestWithAdmin = Pick<PayloadRequest, 'payload' | 'user'>

export function isSuperAdmin(req: Pick<RequestWithAdmin, 'user'>): boolean {
  return req.user?.role === 'super_admin'
}

export const isAuthenticated: Access = ({ req }) => Boolean(req.user)

export function capabilityAccess(capability: Capability): Access {
  return ({ req }) => hasCapability(req.user?.role, capability)
}

export const canManageCatalog: Access = ({ req }) => {
  return req.user?.role === 'super_admin' || req.user?.role === 'publisher'
}

export const canReadAdmin: Access = ({ req }) => {
  if (isSuperAdmin(req)) return true
  if (!req.user) return false

  return { id: { equals: req.user.id } }
}

export const canBootstrapOrManageAdmins: Access = async ({ req }) => {
  if (isSuperAdmin(req)) return true
  if (req.user) return false

  const result = await req.payload.count({
    collection: 'admins',
    overrideAccess: true,
  })

  return result.totalDocs === 0
}
