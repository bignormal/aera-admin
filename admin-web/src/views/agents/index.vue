<script setup lang="ts">
import type {
  ResourceCreate,
  ResourceDelete,
  ResourceList,
  ResourceUpdate,
} from '@/components/platform/resource-crud'
import { useCapability } from '@/composables/use-capability'
import {
  createAgent,
  deleteAgent,
  listAgents,
  updateAgent,
  type AgentInput,
} from '@/service/agents'
import { submitAgentForReview, syncAgentToCloud, validateAgentCloud } from '@/service/publishing'

defineOptions({ name: 'AgentsPage' })

const { can } = useCapability()
const list: ResourceList = async (query, signal) => {
  const result = await listAgents(query, signal)
  return { ...result, docs: result.docs.map((item) => ({ ...item })) }
}
const create: ResourceCreate = (input) => createAgent(input as unknown as AgentInput)
const update: ResourceUpdate = (id, input) => updateAgent(id, input as Partial<AgentInput>)
const remove: ResourceDelete = deleteAgent
const rowActions = [
  {
    label: '同步 Cloud',
    handler: (row: { id: string | number }) => syncAgentToCloud(row.id),
    type: 'primary' as const,
  },
  { label: 'Cloud 校验', handler: (row: { id: string | number }) => validateAgentCloud(row.id) },
  {
    label: '提交审核',
    handler: (row: { id: string | number }) => submitAgentForReview(row.id, 'ready_for_review'),
    type: 'success' as const,
  },
]
</script>

<template>
  <ResourceCrudPage
    title="官方智能体"
    description="维护 Aera 官方智能体草稿、兼容性与发布版本"
    :can-write="can('content:agents:write')"
    :can-publish="false"
    :columns="[
      { key: 'name', label: '名称' },
      { key: 'templateKey', label: '稳定标识' },
      { key: 'category', label: '分类' },
      { key: 'releaseVersion', label: '发布版本' },
      { key: '_status', label: '状态', kind: 'status' },
      { key: 'updatedAt', label: '更新时间', kind: 'date' },
    ]"
    :fields="[
      { key: 'templateKey', label: '稳定标识', required: true },
      { key: 'name', label: '名称', required: true },
      { key: 'avatar', label: '头像媒体 ID', type: 'number', required: true },
      { key: 'category', label: '分类 ID', type: 'number', required: true },
      { key: 'introduction', label: '专家介绍', type: 'textarea', required: true },
      { key: 'rolePrompt', label: '角色提示词', type: 'textarea', required: true },
      { key: 'minimumStudioVersion', label: '最低 Studio 版本' },
      { key: 'minimumRuntimeVersion', label: '最低 Runtime 版本' },
      { key: 'releaseNotes', label: '发布说明', type: 'textarea' },
    ]"
    :defaults="{ _status: 'draft' }"
    :list="list"
    :create="create"
    :update="update"
    :remove="remove"
    :row-actions="can('official-agents:draft:write') ? rowActions : []"
  />
</template>
