import type { CollectionConfig } from 'payload'

import { canManageCatalog, capabilityAccess } from '../access/adminAccess'
import { createAuditHooks } from '../domain/audit'

const categoryAuditHooks = createAuditHooks({
  capability: 'content:categories:write',
  resourceType: 'expert-categories',
})

export const ExpertCategories: CollectionConfig = {
  slug: 'expert-categories',
  labels: { plural: '智能体分类', singular: '智能体分类' },
  admin: { group: '官方智能体', useAsTitle: 'name' },
  access: {
    create: canManageCatalog,
    delete: canManageCatalog,
    read: capabilityAccess('content:categories:read'),
    update: canManageCatalog,
  },
  hooks: {
    afterChange: [categoryAuditHooks.afterChange],
    afterDelete: [categoryAuditHooks.afterDelete],
  },
  fields: [
    {
      name: 'key',
      label: '稳定标识',
      type: 'text',
      required: true,
      unique: true,
      index: true,
    },
    { name: 'name', label: '中文名称', type: 'text', required: true },
    { name: 'englishName', label: '英文名称', type: 'text' },
    { name: 'description', label: '分类说明', type: 'textarea' },
    { name: 'sortOrder', label: '排序', type: 'number', defaultValue: 0, required: true },
    { name: 'active', label: '启用', type: 'checkbox', defaultValue: true, required: true },
  ],
}
