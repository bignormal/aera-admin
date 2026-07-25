<script setup lang="ts">
import type { ResourceCreate, ResourceDelete, ResourceList, ResourceUpdate } from '@/components/platform/resource-crud';
import { listRuntimeCommands } from '@/service/runtime';

defineOptions({ name: 'RuntimeCommandsPage' });
const list: ResourceList = (query, signal) => listRuntimeCommands(query, signal);
const noopCreate: ResourceCreate = async () => undefined;
const noopUpdate: ResourceUpdate = async () => undefined;
const noopDelete: ResourceDelete = async () => undefined;
</script>

<template>
  <ResourceCrudPage
    title="指令记录"
    description="查看平台下发指令的状态和最小化执行摘要"
    hide-create hide-edit hide-delete
    :columns="[
      { key: 'instance', label: '实例' },
      { key: 'type', label: '指令' },
      { key: 'state', label: '状态' },
      { key: 'resultCode', label: '结果码' },
      { key: 'createdAt', label: '创建时间', kind: 'date' },
      { key: 'completedAt', label: '完成时间', kind: 'date' }
    ]"
    :fields="[]" :list="list" :create="noopCreate" :update="noopUpdate" :remove="noopDelete"
  />
</template>
