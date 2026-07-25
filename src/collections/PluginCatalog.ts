import type { CollectionConfig, TextFieldValidation } from 'payload'

import { capabilityAccess } from '../access/adminAccess'
import { createAuditHooks } from '../domain/audit'

const pluginAuditHooks = createAuditHooks({
  capability: 'content:plugins:write',
  resourceType: 'plugin-catalog',
})

const validateVersion: TextFieldValidation = (value) =>
  typeof value === 'string' && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value)
    ? true
    : '版本必须使用 1.2.3 或 1.2.3-beta 格式。'

const validateArtifactURL: TextFieldValidation = (value) => {
  if (typeof value !== 'string') return '必须填写 HTTP(S) 制品地址。'
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:' ? true : '制品地址只允许 HTTP(S)。'
  } catch {
    return '制品地址格式不正确。'
  }
}

export const PluginCatalog: CollectionConfig = {
  slug: 'plugin-catalog',
  labels: { plural: '官方插件', singular: '官方插件' },
  admin: {
    defaultColumns: ['name', 'slug', 'version', 'installKind', 'riskLevel', '_status', 'enabled'],
    group: '官方内容',
    useAsTitle: 'name',
  },
  access: {
    create: capabilityAccess('content:plugins:write'),
    delete: capabilityAccess('content:plugins:write'),
    read: capabilityAccess('content:plugins:read'),
    update: capabilityAccess('content:plugins:write'),
  },
  hooks: {
    afterChange: [pluginAuditHooks.afterChange],
    afterDelete: [pluginAuditHooks.afterDelete],
  },
  indexes: [{ fields: ['slug', 'version'], unique: true }],
  versions: { drafts: { autosave: false }, maxPerDoc: 20 },
  fields: [
    { name: 'name', label: '插件名称', type: 'text', required: true },
    { name: 'slug', label: '稳定标识', type: 'text', index: true, required: true },
    {
      name: 'version',
      label: '版本',
      type: 'text',
      required: true,
      validate: validateVersion,
    },
    { name: 'summary', label: '插件说明', type: 'textarea', required: true },
    {
      name: 'installKind',
      label: '安装方式',
      type: 'select',
      options: [
        { label: '独立插件包', value: 'standalone_plugin' },
        { label: 'Python 包入口', value: 'pip_entry_point' },
        { label: 'Runtime 内置', value: 'runtime_bundled' },
      ],
      required: true,
    },
    {
      name: 'artifactURL',
      label: '制品地址',
      type: 'text',
      required: true,
      validate: validateArtifactURL,
    },
    { name: 'checksum', label: 'SHA-256 校验和', type: 'text', required: true },
    {
      name: 'compatibility',
      label: '兼容性',
      type: 'group',
      fields: [
        { name: 'minimumRuntimeVersion', label: '最低 Runtime 版本', type: 'text' },
        { name: 'maximumRuntimeVersion', label: '最高 Runtime 版本', type: 'text' },
        {
          name: 'platforms',
          label: '支持平台',
          type: 'select',
          hasMany: true,
          options: [
            { label: 'macOS', value: 'macos' },
            { label: 'Windows', value: 'windows' },
            { label: 'Linux', value: 'linux' },
          ],
        },
      ],
    },
    {
      name: 'riskLevel',
      label: '风险级别',
      type: 'select',
      defaultValue: 'low',
      options: [
        { label: '低', value: 'low' },
        { label: '中', value: 'medium' },
        { label: '高', value: 'high' },
      ],
      required: true,
    },
    { name: 'enabled', label: '启用', type: 'checkbox', defaultValue: true, required: true },
  ],
}
