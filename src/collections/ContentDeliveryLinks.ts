import type { CollectionConfig } from 'payload'

import { capabilityAccess } from '../access/adminAccess'
import { deliveryStatuses } from '../domain/content-delivery'

export const ContentDeliveryLinks: CollectionConfig = {
  slug: 'content-delivery-links',
  labels: { plural: '内容交付关联', singular: '内容交付关联' },
  admin: {
    defaultColumns: ['resourceType', 'stableKey', 'syncStatus', 'updatedAt'],
    group: '发布中心',
    hidden: true,
    useAsTitle: 'stableKey',
  },
  access: {
    create: () => false,
    delete: () => false,
    read: capabilityAccess('content:publish:read'),
    update: () => false,
  },
  fields: [
    {
      name: 'resourceType',
      type: 'select',
      options: [
        { label: '官方智能体', value: 'agent' },
        { label: '智能体分类', value: 'category' },
        { label: '技能', value: 'skill' },
        { label: '插件', value: 'plugin' },
      ],
      required: true,
      index: true,
    },
    { name: 'payloadDocumentId', type: 'text', required: true, index: true },
    { name: 'stableKey', type: 'text', required: true, index: true },
    { name: 'cloudDefinitionId', type: 'text', index: true },
    { name: 'cloudDraftId', type: 'text', index: true },
    { name: 'cloudSubmissionId', type: 'text', index: true },
    { name: 'cloudVersionId', type: 'text', index: true },
    { name: 'cloudReleaseId', type: 'text', index: true },
    { name: 'payloadRevision', type: 'number', min: 1 },
    { name: 'contentDigest', type: 'text' },
    { name: 'runtimeManifestSha256', type: 'text' },
    {
      name: 'syncStatus',
      type: 'select',
      options: deliveryStatuses.map((value) => ({ label: value, value })),
      defaultValue: 'local_only',
      required: true,
      index: true,
    },
    { name: 'lastOperationId', type: 'text', index: true },
    { name: 'lastRequestId', type: 'text', index: true },
    { name: 'lastErrorCode', type: 'text' },
    { name: 'lastErrorSummary', type: 'text' },
    { name: 'desktopVerification', type: 'json' },
  ],
}
