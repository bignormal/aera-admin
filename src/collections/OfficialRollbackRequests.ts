import type { CollectionConfig } from 'payload'
import { randomUUID } from 'node:crypto'

import { capabilityAccess } from '../access/adminAccess'
import { createAuditHooks } from '../domain/audit'

const rollbackAuditHooks = createAuditHooks({
  capability: 'official-agents:release:write',
  resourceType: 'official-rollback-requests',
})

// 官方 Agent 发布回滚的双人复核状态机（requested → approved/rejected → executed）。
// 参照旧 aera-admin/internal/officialagent 的 official_agent_rollback_requests：
// 发起人创建请求，另一名管理员批准后，批准人才能执行回滚（云端校验
// approval_id + requester_admin_id，且执行人 ≠ 发起人）。
// 状态流转仅通过 /api/cloud 回滚执行与本集合的受控更新完成。
export const OfficialRollbackRequests: CollectionConfig = {
  slug: 'official-rollback-requests',
  labels: { plural: '官方回滚审批', singular: '官方回滚审批' },
  admin: {
    defaultColumns: ['releaseId', 'status', 'requestedBy', 'decidedBy', 'createdAt'],
    group: '平台管理',
    useAsTitle: 'releaseId',
  },
  access: {
    // 全部写路径由自定义端点经 overrideAccess 完成，禁止直接 API 写入。
    create: () => false,
    delete: () => false,
    read: capabilityAccess('official-agents:read'),
    update: () => false,
  },
  hooks: {
    afterChange: [rollbackAuditHooks.afterChange],
    afterDelete: [rollbackAuditHooks.afterDelete],
    beforeChange: [
      ({ data }) => {
        if (typeof data.approvalId !== 'string' || data.approvalId === '') {
          data.approvalId = randomUUID()
        }
        return data
      },
    ],
  },
  fields: [
    {
      name: 'approvalId',
      label: '审批标识',
      type: 'text',
      admin: { readOnly: true },
      index: true,
      unique: true,
    },
    {
      name: 'releaseId',
      label: '发布 ID',
      type: 'text',
      index: true,
      required: true,
    },
    {
      name: 'targetVersionId',
      label: '目标版本 ID',
      type: 'text',
      required: true,
    },
    {
      name: 'targetReleaseRevisionId',
      label: '目标发布修订 ID',
      type: 'text',
      required: true,
    },
    {
      name: 'expectedRevision',
      label: '期望修订号',
      type: 'number',
      min: 1,
      required: true,
    },
    {
      name: 'reasonCode',
      label: '原因码',
      type: 'text',
      required: true,
    },
    {
      name: 'ticketReference',
      label: '工单编号',
      type: 'text',
    },
    {
      name: 'status',
      label: '状态',
      type: 'select',
      defaultValue: 'requested',
      index: true,
      options: [
        { label: '待审批', value: 'requested' },
        { label: '已批准', value: 'approved' },
        { label: '已拒绝', value: 'rejected' },
        { label: '已执行', value: 'executed' },
        { label: '已取消', value: 'cancelled' },
      ],
      required: true,
    },
    {
      name: 'requestedBy',
      label: '发起人',
      type: 'relationship',
      admin: { readOnly: true },
      relationTo: 'admins',
      required: true,
    },
    {
      name: 'requestedByActorId',
      label: '发起人云标识',
      type: 'text',
      admin: { readOnly: true },
      required: true,
    },
    {
      name: 'decidedBy',
      label: '审批人',
      type: 'relationship',
      admin: { readOnly: true },
      relationTo: 'admins',
    },
    {
      name: 'decidedByActorId',
      label: '审批人云标识',
      type: 'text',
      admin: { readOnly: true },
    },
    {
      name: 'decidedAt',
      label: '审批时间',
      type: 'date',
      admin: { readOnly: true },
    },
    {
      name: 'decisionNote',
      label: '审批说明',
      type: 'textarea',
    },
    {
      name: 'executedAt',
      label: '执行时间',
      type: 'date',
      admin: { readOnly: true },
    },
    {
      name: 'operationId',
      label: '云端操作 ID',
      type: 'text',
      admin: { readOnly: true },
    },
  ],
}
