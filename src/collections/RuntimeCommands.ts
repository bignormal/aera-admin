import type { CollectionConfig, FieldAccess } from 'payload'

import { capabilityAccess } from '../access/adminAccess'
import { runtimeCommandStates, runtimeCommandTypes } from '../domain/runtime-control'

const serviceOnly: FieldAccess = () => false

export const RuntimeCommands: CollectionConfig = {
  slug: 'runtime-commands',
  labels: { plural: 'Runtime 命令', singular: 'Runtime 命令' },
  admin: {
    defaultColumns: ['instance', 'type', 'state', 'createdAt', 'completedAt'],
    group: '运行时管理',
    useAsTitle: 'idempotencyKey',
  },
  access: {
    create: () => false,
    delete: () => false,
    read: capabilityAccess('runtime:read'),
    update: () => false,
  },
  fields: [
    { name: 'instance', type: 'relationship', relationTo: 'runtime-instances', required: true, index: true },
    { name: 'type', type: 'select', options: [...runtimeCommandTypes], required: true },
    { name: 'requiredCapability', type: 'text', required: true },
    { name: 'idempotencyKey', type: 'text', required: true },
    {
      name: 'commandKey',
      type: 'text',
      unique: true,
      required: true,
      admin: { hidden: true },
      access: { create: serviceOnly, read: serviceOnly, update: serviceOnly },
    },
    {
      name: 'state',
      type: 'select',
      options: [...runtimeCommandStates],
      defaultValue: 'queued',
      required: true,
      access: { create: serviceOnly, update: serviceOnly },
    },
    { name: 'expiresAt', type: 'date', index: true },
    { name: 'claimedAt', type: 'date' },
    { name: 'startedAt', type: 'date' },
    { name: 'completedAt', type: 'date' },
    { name: 'resultCode', type: 'text' },
    { name: 'resultSummary', type: 'json' },
    { name: 'createdBy', type: 'relationship', relationTo: 'admins' },
  ],
}
