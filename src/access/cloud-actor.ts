import { randomUUID } from 'node:crypto'
import type { PayloadRequest } from 'payload'

import { type AdminRole, isAdminRole } from './capabilities'

// aera-cloud 的 allowedOfficialRoles 为
// {super_admin, developer, operator, support, finance, auditor}，
// 此处将本地管理员角色映射到云端认可的服务角色。
const cloudRoleByAdminRole: Record<AdminRole, string> = {
  super_admin: 'super_admin',
  operations_admin: 'operator',
  publisher: 'developer',
  finance_admin: 'finance',
  auditor: 'auditor',
}

export type CloudAdminIdentity = {
  adminUUID: string
  cloudRole: string
  role: AdminRole
}

const canonicalUUIDPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

// 解析当前管理员的云 actor 身份；存量账号缺少 cloudActorId 时自动补齐落库，
// 保证 Admins 集合上线前创建的账号无需人工干预即可调用云端管理 API。
export async function cloudIdentityFromRequest(
  req: PayloadRequest,
): Promise<CloudAdminIdentity | undefined> {
  const user = req.user
  if (!user || !isAdminRole(user.role)) return undefined

  let adminUUID = typeof user.cloudActorId === 'string' ? user.cloudActorId : ''
  if (!canonicalUUIDPattern.test(adminUUID)) {
    try {
      const doc = (await req.payload.findByID({
        collection: 'admins',
        depth: 0,
        id: user.id,
        overrideAccess: true,
      })) as { cloudActorId?: unknown }
      adminUUID = typeof doc.cloudActorId === 'string' ? doc.cloudActorId : ''
      if (!canonicalUUIDPattern.test(adminUUID)) {
        adminUUID = randomUUID()
        await req.payload.update({
          collection: 'admins',
          data: { cloudActorId: adminUUID },
          id: user.id,
          overrideAccess: true,
          req,
        })
      }
    } catch {
      return undefined
    }
  }
  if (!canonicalUUIDPattern.test(adminUUID)) return undefined

  return {
    adminUUID,
    cloudRole: cloudRoleByAdminRole[user.role],
    role: user.role,
  }
}
