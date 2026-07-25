import type { CollectionConfig } from 'payload'

import { capabilityAccess } from '../access/adminAccess'
import { adminRoleLabels, adminRoles, capabilities } from '../access/capabilities'

export const AuditLogs: CollectionConfig = {
  slug: 'audit-logs',
  labels: { plural: '审计日志', singular: '审计日志' },
  admin: {
    defaultColumns: ['occurredAt', 'actorEmail', 'action', 'resourceType', 'outcome'],
    group: '系统管理',
    useAsTitle: 'action',
  },
  access: {
    create: () => false,
    delete: () => false,
    read: capabilityAccess('audit:read'),
    update: () => false,
  },
  defaultSort: '-occurredAt',
  timestamps: false,
  fields: [
    { name: 'actorId', label: '操作者 ID', type: 'text', index: true, required: true },
    { name: 'actorEmail', label: '操作者邮箱', type: 'email', index: true },
    {
      name: 'actorRole',
      label: '操作者角色',
      type: 'select',
      options: adminRoles.map((value) => ({ label: adminRoleLabels[value], value })),
      required: true,
    },
    {
      name: 'capability',
      label: '权限能力',
      type: 'select',
      options: capabilities.map((value) => ({ label: value, value })),
      required: true,
    },
    { name: 'action', label: '动作', type: 'text', index: true, required: true },
    { name: 'resourceType', label: '资源类型', type: 'text', index: true, required: true },
    { name: 'resourceId', label: '资源 ID', type: 'text', index: true },
    { name: 'resourceName', label: '资源名称', type: 'text' },
    { name: 'requestId', label: '请求编号', type: 'text', index: true, required: true },
    { name: 'upstreamRequestId', label: '上游请求编号', type: 'text', index: true },
    {
      name: 'outcome',
      label: '结果',
      type: 'select',
      options: [
        { label: '成功', value: 'succeeded' },
        { label: '失败', value: 'failed' },
      ],
      required: true,
    },
    { name: 'errorCode', label: '错误码', type: 'text' },
    { name: 'ip', label: 'IP', type: 'text' },
    { name: 'userAgent', label: 'User-Agent', type: 'text' },
    { name: 'before', label: '变更前', type: 'json' },
    { name: 'after', label: '变更后', type: 'json' },
    {
      name: 'occurredAt',
      label: '发生时间',
      type: 'date',
      defaultValue: () => new Date().toISOString(),
      index: true,
      required: true,
    },
  ],
}
