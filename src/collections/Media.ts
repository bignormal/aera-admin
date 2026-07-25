import type { CollectionConfig } from 'payload'

import { canManageCatalog, isAuthenticated } from '../access/adminAccess'
import { createAuditHooks } from '../domain/audit'

const mediaAuditHooks = createAuditHooks({
  capability: 'content:media:write',
  resourceType: 'media',
})

export const Media: CollectionConfig = {
  slug: 'media',
  labels: { plural: '媒体资源', singular: '媒体资源' },
  admin: { group: '官方智能体' },
  access: {
    create: canManageCatalog,
    delete: canManageCatalog,
    read: isAuthenticated,
    update: canManageCatalog,
  },
  hooks: {
    afterChange: [mediaAuditHooks.afterChange],
    afterDelete: [mediaAuditHooks.afterDelete],
  },
  fields: [
    {
      name: 'alt',
      label: '图片说明',
      type: 'text',
      required: true,
    },
    {
      name: 'attribution',
      label: '来源说明',
      type: 'text',
    },
  ],
  upload: {
    mimeTypes: ['image/jpeg', 'image/png', 'image/webp'],
  },
}
