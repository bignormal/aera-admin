import type { CollectionConfig } from 'payload'

import { capabilityAccess } from '../access/adminAccess'
import { createAuditHooks } from '../domain/audit'

const skillAuditHooks = createAuditHooks({
  capability: 'content:skills:write',
  resourceType: 'skill-catalog',
})

export const SkillCatalog: CollectionConfig = {
  slug: 'skill-catalog',
  labels: { plural: '技能目录', singular: '技能' },
  admin: {
    defaultColumns: ['name', 'key', 'runtimeSkillId', '_status', 'active'],
    group: '官方智能体',
    useAsTitle: 'name',
  },
  access: {
    create: capabilityAccess('content:skills:write'),
    delete: capabilityAccess('content:skills:write'),
    read: capabilityAccess('content:skills:read'),
    update: capabilityAccess('content:skills:write'),
  },
  hooks: {
    afterChange: [skillAuditHooks.afterChange],
    afterDelete: [skillAuditHooks.afterDelete],
  },
  versions: { drafts: { autosave: false }, maxPerDoc: 20 },
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
    { name: 'description', label: '技能说明', type: 'textarea' },
    {
      name: 'runtimeSkillId',
      label: 'Hermes Runtime 技能标识',
      type: 'text',
      required: true,
    },
    { name: 'minimumRuntimeVersion', label: '最低 Runtime 版本', type: 'text' },
    { name: 'active', label: '启用', type: 'checkbox', defaultValue: true, required: true },
  ],
}
