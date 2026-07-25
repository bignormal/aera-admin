import type { CollectionConfig } from 'payload'

import { capabilityAccess } from '../access/adminAccess'

export const RuntimeEvents: CollectionConfig = {
  slug: 'runtime-events',
  labels: { plural: 'Runtime 事件', singular: 'Runtime 事件' },
  admin: {
    defaultColumns: ['instance', 'kind', 'severity', 'code', 'occurredAt'],
    group: '运行时管理',
    useAsTitle: 'summary',
  },
  access: {
    create: () => false,
    delete: () => false,
    read: capabilityAccess('runtime:read'),
    update: () => false,
  },
  fields: [
    { name: 'instance', type: 'relationship', relationTo: 'runtime-instances', required: true, index: true },
    { name: 'kind', type: 'text', required: true, index: true },
    { name: 'severity', type: 'select', options: ['info', 'warning', 'error'], required: true },
    { name: 'code', type: 'text', index: true },
    { name: 'summary', type: 'text', required: true, maxLength: 500 },
    { name: 'occurredAt', type: 'date', required: true, index: true },
    { name: 'expiresAt', type: 'date', index: true },
  ],
}
