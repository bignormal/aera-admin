import type { CollectionConfig } from 'payload'

import { capabilityAccess } from '../access/adminAccess'
import { createAuditHooks } from '../domain/audit'

const auditHooks = createAuditHooks({ capability: 'runtime:command:create', resourceType: 'runtime-releases' })

export const RuntimeReleases: CollectionConfig = {
  slug: 'runtime-releases',
  labels: { plural: 'Runtime 版本', singular: 'Runtime 版本' },
  admin: {
    defaultColumns: ['product', 'version', 'channel', 'status', 'publishedAt'],
    group: '运行时管理',
    useAsTitle: 'version',
  },
  access: {
    create: capabilityAccess('runtime:command:create'),
    delete: capabilityAccess('runtime:command:create'),
    read: capabilityAccess('runtime:read'),
    update: capabilityAccess('runtime:command:create'),
  },
  hooks: { afterChange: [auditHooks.afterChange], afterDelete: [auditHooks.afterDelete] },
  fields: [
    { name: 'product', type: 'select', options: ['runtime', 'studio', 'desktop'], required: true },
    { name: 'version', type: 'text', required: true },
    { name: 'channel', type: 'select', options: ['stable', 'beta', 'nightly'], required: true },
    { name: 'minimumVersion', type: 'text' },
    { name: 'artifactURL', type: 'text', required: true },
    { name: 'checksum', type: 'text', required: true },
    { name: 'publishedAt', type: 'date' },
    {
      name: 'status',
      type: 'select',
      options: ['draft', 'published', 'retired'],
      defaultValue: 'draft',
      required: true,
    },
  ],
}
