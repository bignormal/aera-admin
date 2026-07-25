import {
  ValidationError,
  type CollectionBeforeValidateHook,
  type CollectionConfig,
  type TextFieldValidation,
} from 'payload'

import { capabilityAccess } from '../access/adminAccess'
import { createAuditHooks } from '../domain/audit'

function relationID(value: unknown): number | string | undefined {
  if (typeof value === 'number' || typeof value === 'string') return value
  if (value && typeof value === 'object' && 'id' in value) {
    const id = (value as { id?: unknown }).id
    return typeof id === 'number' || typeof id === 'string' ? id : undefined
  }
  return undefined
}

const validatePetPublish: CollectionBeforeValidateHook = ({ data, originalDoc, req }) => {
  const next = { ...originalDoc, ...data }
  if (next._status !== 'published') return data

  const errors: Array<{ message: string; path: string }> = []
  const manifest = next.manifest
  if (
    !manifest ||
    typeof manifest !== 'object' ||
    Array.isArray(manifest) ||
    Object.keys(manifest).length === 0
  ) {
    errors.push({ message: '发布宠物前必须提供 manifest。', path: 'manifest' })
  }
  if (relationID(next.spriteMedia) === undefined) {
    errors.push({ message: '发布宠物前必须上传图集媒体。', path: 'spriteMedia' })
  }

  if (errors.length) throw new ValidationError({ errors, req })
  return data
}

const petAuditHooks = createAuditHooks({
  capability: 'content:pets:write',
  resourceType: 'pet-assets',
})

const validateVersion: TextFieldValidation = (value) =>
  typeof value === 'string' && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value)
    ? true
    : '版本必须使用 1.2.3 或 1.2.3-beta 格式。'

export const PetAssets: CollectionConfig = {
  slug: 'pet-assets',
  labels: { plural: '宠物资源', singular: '宠物资源' },
  admin: {
    defaultColumns: ['name', 'slug', 'version', '_status', 'enabled', 'updatedAt'],
    group: '官方内容',
    useAsTitle: 'name',
  },
  access: {
    create: capabilityAccess('content:pets:write'),
    delete: capabilityAccess('content:pets:write'),
    read: capabilityAccess('content:pets:read'),
    update: capabilityAccess('content:pets:write'),
  },
  hooks: {
    afterChange: [petAuditHooks.afterChange],
    afterDelete: [petAuditHooks.afterDelete],
    beforeValidate: [validatePetPublish],
  },
  indexes: [{ fields: ['slug', 'version'], unique: true }],
  versions: { drafts: { autosave: false }, maxPerDoc: 20 },
  fields: [
    { name: 'name', label: '宠物名称', type: 'text', required: true },
    { name: 'slug', label: '稳定标识', type: 'text', index: true, required: true },
    {
      name: 'version',
      label: '版本',
      type: 'text',
      required: true,
      validate: validateVersion,
    },
    { name: 'manifest', label: 'pet.json Manifest', type: 'json' },
    {
      name: 'spriteMedia',
      label: '动画图集',
      type: 'relationship',
      relationTo: 'media',
    },
    {
      name: 'previewMedia',
      label: '预览图',
      type: 'relationship',
      relationTo: 'media',
    },
    {
      name: 'compatibility',
      label: '兼容性',
      type: 'group',
      fields: [
        { name: 'minimumStudioVersion', label: '最低 Studio 版本', type: 'text' },
        { name: 'minimumRuntimeVersion', label: '最低 Runtime 版本', type: 'text' },
      ],
    },
    { name: 'enabled', label: '启用', type: 'checkbox', defaultValue: true, required: true },
  ],
}
