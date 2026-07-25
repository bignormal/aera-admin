import type { CollectionConfig, FieldAccess } from 'payload'

import { capabilityAccess } from '../access/adminAccess'

const serviceOnly: FieldAccess = () => false

export const RuntimeInstances: CollectionConfig = {
  slug: 'runtime-instances',
  labels: { plural: 'Runtime 实例', singular: 'Runtime 实例' },
  admin: {
    defaultColumns: ['name', 'instanceType', 'status', 'version', 'lastHeartbeatAt'],
    group: '运行时管理',
    useAsTitle: 'name',
  },
  access: {
    create: () => false,
    delete: () => false,
    read: capabilityAccess('runtime:read'),
    update: () => false,
  },
  fields: [
    { name: 'name', type: 'text', required: true },
    {
      name: 'instanceType',
      type: 'select',
      options: ['runtime', 'studio', 'desktop'],
      required: true,
    },
    { name: 'tenantId', type: 'text', index: true },
    {
      name: 'status',
      type: 'select',
      defaultValue: 'pending',
      options: ['pending', 'offline', 'online', 'disabled'],
      required: true,
    },
    {
      name: 'deviceIdHash',
      type: 'text',
      unique: true,
      required: true,
      admin: { hidden: true },
      access: { create: serviceOnly, read: serviceOnly, update: serviceOnly },
    },
    {
      name: 'deviceSecretHash',
      type: 'text',
      admin: { hidden: true },
      access: { create: serviceOnly, read: serviceOnly, update: serviceOnly },
    },
    {
      name: 'enrollmentCodeHash',
      type: 'text',
      unique: true,
      admin: { hidden: true },
      access: { create: serviceOnly, read: serviceOnly, update: serviceOnly },
    },
    {
      name: 'enrollmentExpiresAt',
      type: 'date',
      admin: { hidden: true },
      access: { create: serviceOnly, read: serviceOnly, update: serviceOnly },
    },
    { name: 'version', type: 'text' },
    { name: 'os', type: 'text' },
    { name: 'arch', type: 'text' },
    { name: 'capabilities', type: 'json', defaultValue: [] },
    { name: 'lastHeartbeatAt', type: 'date', index: true },
    { name: 'healthSummary', type: 'json' },
    { name: 'channels', type: 'json', defaultValue: [] },
    { name: 'resources', type: 'json' },
  ],
}
