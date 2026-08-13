<script setup lang="ts">
import type {
  ResourceCreate,
  ResourceDelete,
  ResourceList,
  ResourceUpdate,
} from '@/components/platform/resource-crud'
import { useCapability } from '@/composables/use-capability'
import {
  createSkill,
  deleteSkill,
  listSkills,
  updateSkill,
  type SkillInput,
} from '@/service/skills'
import { publishResource, saveResourceDraft } from '@/service/publishing'

defineOptions({ name: 'SkillsPage' })

const { can } = useCapability()
const list: ResourceList = async (query, signal) => {
  const result = await listSkills(query, signal)
  return { ...result, docs: result.docs.map((item) => ({ ...item })) }
}
const create: ResourceCreate = (input) => createSkill(input as unknown as SkillInput)
const update: ResourceUpdate = (id, input) => updateSkill(id, input as Partial<SkillInput>)
const remove: ResourceDelete = deleteSkill
</script>

<template>
  <ResourceCrudPage
    title="技能目录"
    description="维护 Runtime 技能标识、兼容版本与启用状态"
    :can-write="can('content:skills:write')"
    :can-publish="can('content:skills:publish')"
    :columns="[
      { key: 'name', label: '名称' },
      { key: 'key', label: '稳定标识' },
      { key: 'runtimeSkillId', label: 'Runtime 技能标识' },
      {
        key: 'distributionClass',
        label: '分发类别',
        options: [
          { label: 'Runtime 公开技能', value: 'runtime_public' },
          { label: 'Cloud 专有（不可下发）', value: 'cloud_proprietary' },
        ],
      },
      { key: 'minimumRuntimeVersion', label: '最低 Runtime 版本' },
      { key: '_status', label: '状态', kind: 'status' },
      { key: 'active', label: '状态', kind: 'boolean' },
      { key: 'updatedAt', label: '更新时间', kind: 'date' },
    ]"
    :fields="[
      { key: 'key', label: '稳定标识', required: true },
      { key: 'name', label: '名称', required: true },
      {
        key: 'distributionClass',
        label: '分发类别',
        type: 'select',
        required: true,
        options: [
          { label: 'Runtime 公开技能', value: 'runtime_public' },
          { label: 'Cloud 专有技能', value: 'cloud_proprietary' },
        ],
      },
      { key: 'runtimeSkillId', label: 'Runtime 技能标识' },
      { key: 'minimumRuntimeVersion', label: '最低 Runtime 版本' },
      { key: 'description', label: '说明', type: 'textarea' },
      { key: 'active', label: '启用', type: 'switch' },
    ]"
    :defaults="{ _status: 'draft', active: true, distributionClass: 'runtime_public' }"
    :list="list"
    :create="create"
    :update="update"
    :remove="remove"
    :publish="(id) => publishResource('skill-catalog', id)"
    :unpublish="(id) => saveResourceDraft('skill-catalog', id)"
  />
</template>
