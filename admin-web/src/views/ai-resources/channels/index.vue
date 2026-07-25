<script setup lang="ts">
import type { ResourceCreate, ResourceDelete, ResourceList, ResourceUpdate } from '@/components/platform/resource-crud';
import { useCapability } from '@/composables/use-capability';
import { createAIResource, deleteAIResource, listAIResources, updateAIResource } from '@/service/ai-resources';

defineOptions({ name: 'AIResourceChannelsPage' });
const { can } = useCapability();
const list: ResourceList = (query, signal) => listAIResources('channels', query, signal);
const create: ResourceCreate = input => createAIResource('channels', input);
const update: ResourceUpdate = (id, input) => updateAIResource('channels', id, input);
const remove: ResourceDelete = id => deleteAIResource('channels', id);
</script>

<template>
  <ResourceCrudPage
    title="模型渠道"
    description="统一维护渠道、模型映射和计价规则"
    :can-write="can('ai-resources:write')"
    :columns="[
      { key: 'name', label: '渠道名称' },
      { key: 'description', label: '说明' },
      { key: 'billing_model_source', label: '计价来源' },
      { key: 'restrict_models', label: '限制模型', kind: 'boolean' },
      {
        key: 'status',
        label: '状态',
        options: [
          { label: '启用', value: 'active' },
          { label: '停用', value: 'inactive' }
        ]
      }
    ]"
    :fields="[
      { key: 'name', label: '渠道名称', required: true },
      { key: 'description', label: '说明', type: 'textarea' },
      {
        key: 'status',
        label: '状态',
        type: 'select',
        options: [
          { label: '启用', value: 'active' },
          { label: '停用', value: 'inactive' }
        ]
      },
      { key: 'billing_model_source', label: '计价来源' },
      { key: 'restrict_models', label: '仅允许配置模型', type: 'switch' },
      { key: 'group_ids', label: '关联分组 ID JSON', type: 'json' },
      { key: 'model_pricing', label: '模型计价 JSON', type: 'json' },
      { key: 'model_mapping', label: '模型映射 JSON', type: 'json' },
      { key: 'features_config', label: '功能配置 JSON', type: 'json' }
    ]"
    :defaults="{ status: 'active', restrict_models: false, billing_model_source: 'channel' }"
    :list="list"
    :create="create"
    :update="update"
    :remove="remove"
  />
</template>
