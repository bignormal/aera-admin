import type { CollectionConfig } from 'payload'

import { capabilityAccess } from '../access/adminAccess'
import { createAuditHooks } from '../domain/audit'

const integrationAuditHooks = createAuditHooks({
  capability: 'system:write',
  resourceType: 'integration-settings',
})

export const IntegrationSettings: CollectionConfig = {
  slug: 'integration-settings',
  labels: { plural: '服务集成状态', singular: '服务集成状态' },
  admin: {
    defaultColumns: ['service', 'enabled', 'healthStatus', 'lastCheckedAt', 'lastErrorCode'],
    group: '系统管理',
    useAsTitle: 'service',
  },
  access: {
    create: capabilityAccess('system:write'),
    delete: capabilityAccess('system:write'),
    read: capabilityAccess('system:read'),
    update: capabilityAccess('system:write'),
  },
  hooks: {
    afterChange: [integrationAuditHooks.afterChange],
    afterDelete: [integrationAuditHooks.afterDelete],
  },
  fields: [
    {
      name: 'service',
      label: '服务',
      type: 'select',
      options: [{ label: 'AgentEra API', value: 'agentera_api' }],
      required: true,
      unique: true,
    },
    { name: 'enabled', label: '已配置', type: 'checkbox', defaultValue: false, required: true },
    {
      name: 'healthStatus',
      label: '健康状态',
      type: 'select',
      options: [
        { label: '健康', value: 'healthy' },
        { label: '不可用', value: 'unavailable' },
        { label: '未配置', value: 'not_configured' },
      ],
      required: true,
    },
    { name: 'lastCheckedAt', label: '最近检查时间', type: 'date', required: true },
    { name: 'lastErrorCode', label: '最近错误码', type: 'text' },
  ],
}
