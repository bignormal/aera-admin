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
    title="Legacy Runtime / Studio 指令记录"
    description="仅兼容旧 Payload Runtime/Studio 记录；Cloud Desktop V1 健康检查结果请在实例详情或用户 Desktop 终端中查看。"
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
