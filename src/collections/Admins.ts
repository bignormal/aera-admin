import { AuthenticationError, type CollectionConfig } from 'payload'
import { randomUUID } from 'node:crypto'

import { canBootstrapOrManageAdmins, canReadAdmin, isSuperAdmin } from '../access/adminAccess'
import { adminRoleLabels, adminRoles } from '../access/capabilities'
import {
  auditAdminLogin,
  auditAdminLogout,
  createAuditHooks,
  markAdminPasswordChange,
} from '../domain/audit'

const adminAuditHooks = createAuditHooks({ capability: 'admins:write', resourceType: 'admins' })

type BeforeLoginHook = NonNullable<NonNullable<CollectionConfig['hooks']>['beforeLogin']>[number]
type BeforeChangeHook = NonNullable<NonNullable<CollectionConfig['hooks']>['beforeChange']>[number]

export const rejectInactiveAdminLogin: BeforeLoginHook = ({ user }) => {
  if (user.active === false) throw new AuthenticationError()
}

// 云端内部管理 API 要求 actor 为 canonical UUID，为每个管理员补齐稳定的云 actor 标识。
export const ensureCloudActorId: BeforeChangeHook = ({ data }) => {
  if (typeof data.cloudActorId !== 'string' || data.cloudActorId === '') {
    data.cloudActorId = randomUUID()
  }
  return data
}

export const Admins: CollectionConfig = {
  slug: 'admins',
  labels: { plural: '管理员', singular: '管理员' },
  admin: {
    group: '系统管理',
    useAsTitle: 'email',
  },
  auth: true,
  access: {
    create: canBootstrapOrManageAdmins,
    delete: ({ req }) => isSuperAdmin(req),
    read: canReadAdmin,
    update: ({ req }) => isSuperAdmin(req),
  },
  hooks: {
    afterChange: [adminAuditHooks.afterChange],
    afterDelete: [adminAuditHooks.afterDelete],
    afterLogin: [auditAdminLogin],
    afterLogout: [auditAdminLogout],
    beforeChange: [markAdminPasswordChange, ensureCloudActorId],
    beforeLogin: [rejectInactiveAdminLogin],
  },
  fields: [
    {
      name: 'displayName',
      label: '姓名',
      type: 'text',
      required: true,
    },
    {
      name: 'role',
      label: '角色',
      type: 'select',
      defaultValue: 'super_admin',
      required: true,
      saveToJWT: true,
      options: adminRoles.map((value) => ({ label: adminRoleLabels[value], value })),
    },
    {
      name: 'active',
      label: '启用',
      type: 'checkbox',
      defaultValue: true,
      required: true,
      saveToJWT: true,
    },
    {
      name: 'cloudActorId',
      label: '云 Actor 标识',
      type: 'text',
      admin: {
        description: '调用 aera-cloud 内部管理 API 时使用的稳定 UUID 身份，自动生成。',
        readOnly: true,
      },
      index: true,
      saveToJWT: true,
      unique: true,
    },
    {
      name: 'totpSecret',
      type: 'text',
      hidden: true,
    },
    {
      name: 'totpEnabledAt',
      label: 'TOTP 启用时间',
      type: 'date',
      admin: {
        description: '高危操作二次验证（TOTP）的绑定时间，未绑定时为空。',
        readOnly: true,
      },
    },
    {
      name: 'stepUpVerifiedAt',
      type: 'date',
      hidden: true,
    },
  ],
}
