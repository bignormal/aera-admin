<script setup lang="ts">
import type { ResourceCreate, ResourceDelete, ResourceList, ResourceRowAction, ResourceUpdate } from '@/components/platform/resource-crud';
import { useCapability } from '@/composables/use-capability';
import {
  createUserAttributeDefinition,
  deleteUserAttributeDefinition,
  listUserAttributeDefinitions,
  reorderUserAttributeDefinitions,
  updateUserAttributeDefinition
} from '@/service/users';

const { can } = useCapability();
const list: ResourceList = (query, signal) => listUserAttributeDefinitions(query, signal);
const create: ResourceCreate = input => createUserAttributeDefinition(input);
const update: ResourceUpdate = (id, input) => updateUserAttributeDefinition(id, input);
const remove: ResourceDelete = id => deleteUserAttributeDefinition(id);
const typeOptions = ['string', 'number', 'boolean', 'select', 'json'].map(value => ({ label: value, value }));

const rowActions: ResourceRowAction[] = [
  {
    label: '调整顺序',
    type: 'info',
    async handler(row) {
      const value = window.prompt('请输入新的排序值 sort_order', String(row.sort_order ?? 0));
      if (value === null) return;
      const sortOrder = Number(value);
      if (!Number.isInteger(sortOrder) || sortOrder < 0) {
        window.$message?.warning('排序值必须是非负整数。');
        return;
      }
      await reorderUserAttributeDefinitions([{ id: row.id, sort_order: sortOrder }]);
    }
  }
];
</script>

<template>
  <ResourceCrudPage
    title="用户属性定义"
    description="定义平台用户可维护的扩展属性，并支持排序"
    :can-write="can('users:write')"
    :columns="[
      { key: 'key', label: '属性 Key' },
      { key: 'label', label: '展示名' },
      { key: 'type', label: '类型', options: typeOptions },
      { key: 'required', label: '必填', kind: 'boolean' },
      { key: 'sort_order', label: '排序' }
    ]"
    :fields="[
      { key: 'key', label: '属性 Key', required: true },
      { key: 'label', label: '展示名', required: true },
      { key: 'type', label: '类型', type: 'select', options: typeOptions, required: true },
      { key: 'required', label: '必填', type: 'switch' },
      { key: 'sort_order', label: '排序', type: 'number' },
      { key: 'options', label: '选项 JSON', type: 'json' },
      { key: 'description', label: '说明', type: 'textarea' }
    ]"
    :defaults="{ type: 'string', required: false, sort_order: 0 }"
    :list="list"
    :create="create"
    :update="update"
    :remove="remove"
    :row-actions="rowActions"
  />
</template>
