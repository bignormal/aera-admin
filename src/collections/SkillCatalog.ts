import type { CollectionConfig } from 'payload'

import { capabilityAccess } from '../access/adminAccess'
import { createAuditHooks } from '../domain/audit'
import { validateSkillDistribution } from '../domain/publishing'

const skillAuditHooks = createAuditHooks({
  capability: 'content:skills:write',
  resourceType: 'skill-catalog',
})

export const SkillCatalog: CollectionConfig = {
  slug: 'skill-catalog',
  labels: { plural: '技能目录', singular: '技能' },
  admin: {
    defaultColumns: ['name', 'key', 'distributionClass', 'runtimeSkillId', '_status', 'active'],
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
    beforeValidate: [validateSkillDistribution],
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
      name: 'distributionClass',
      label: '分发类别',
      type: 'select',
      defaultValue: 'runtime_public',
      options: [
        { label: 'Runtime 公开技能', value: 'runtime_public' },
        { label: 'Cloud 专有技能', value: 'cloud_proprietary' },
      ],
      required: true,
    },
    {
      name: 'runtimeSkillId',
      label: 'Aera Runtime 技能标识',
      type: 'text',
      admin: {
        condition: (_data, siblingData) => siblingData.distributionClass !== 'cloud_proprietary',
      },
    },
    { name: 'minimumRuntimeVersion', label: '最低 Runtime 版本', type: 'text' },
    { name: 'active', label: '启用', type: 'checkbox', defaultValue: true, required: true },
  ],
}
