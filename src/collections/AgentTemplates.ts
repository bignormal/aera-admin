import type { CollectionConfig } from 'payload'

import { canManageCatalog, isAuthenticated } from '../access/adminAccess'
import { createAuditHooks } from '../domain/audit'
import { assignReleaseVersion, validateAgentPublish } from '../domain/publishing'

const agentTemplateAuditHooks = createAuditHooks({
  capability: 'content:agents:write',
  resourceType: 'agent-templates',
})

export const AgentTemplates: CollectionConfig = {
  slug: 'agent-templates',
  labels: { plural: '官方智能体', singular: '官方智能体' },
  admin: {
    components: {
      beforeList: ['/components/admin/AgentListOverview#AgentListOverview'],
    },
    defaultColumns: ['name', 'category', 'skills', '_status', 'releaseVersion', 'updatedAt'],
    group: '官方智能体',
    useAsTitle: 'name',
  },
  access: {
    create: canManageCatalog,
    delete: canManageCatalog,
    read: isAuthenticated,
    update: canManageCatalog,
  },
  hooks: {
    afterChange: [agentTemplateAuditHooks.afterChange],
    afterDelete: [agentTemplateAuditHooks.afterDelete],
    beforeChange: [assignReleaseVersion],
    beforeValidate: [validateAgentPublish],
  },
  versions: { drafts: { autosave: false }, maxPerDoc: 30 },
  fields: [
    {
      name: 'templateKey',
      label: '稳定标识',
      type: 'text',
      required: true,
      unique: true,
      index: true,
    },
    {
      name: 'name',
      label: '中文名称',
      type: 'text',
      required: true,
      admin: { components: { Cell: '/components/admin/AgentNameCell#AgentNameCell' } },
    },
    { name: 'englishName', label: '英文名称', type: 'text' },
    {
      name: 'avatar',
      label: '头像',
      type: 'upload',
      relationTo: 'media',
      required: true,
    },
    {
      name: 'category',
      label: '分类',
      type: 'relationship',
      relationTo: 'expert-categories',
      required: true,
    },
    {
      name: 'tags',
      label: '标签',
      type: 'array',
      fields: [{ name: 'value', label: '标签', type: 'text', required: true }],
    },
    { name: 'introduction', label: '专家介绍', type: 'textarea', required: true },
    { name: 'rolePrompt', label: '角色提示词', type: 'textarea', required: true },
    {
      name: 'skills',
      label: '默认技能',
      type: 'relationship',
      relationTo: 'skill-catalog',
      hasMany: true,
    },
    {
      name: 'releaseVersion',
      label: '发布版本',
      type: 'number',
      defaultValue: 0,
      admin: { readOnly: true },
    },
    { name: 'releaseNotes', label: '发布说明', type: 'textarea' },
    { name: 'minimumStudioVersion', label: '最低 Studio 版本', type: 'text' },
    { name: 'minimumRuntimeVersion', label: '最低 Runtime 版本', type: 'text' },
    { name: 'publishedFingerprint', type: 'text', admin: { hidden: true } },
  ],
}
