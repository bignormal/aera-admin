<script setup lang="ts">
import type { ResourceCreate, ResourceDelete, ResourceList, ResourceUpdate } from '@/components/platform/resource-crud';
import { listRuntimeEvents } from '@/service/runtime';

defineOptions({ name: 'RuntimeEventsPage' });
const list: ResourceList = (query, signal) => listRuntimeEvents(query, signal);
const noopCreate: ResourceCreate = async () => undefined;
const noopUpdate: ResourceUpdate = async () => undefined;
const noopDelete: ResourceDelete = async () => undefined;
</script>

<template>
  <ResourceCrudPage
    title="运行事件"
    description="查看 Runtime 与 Studio 上报的状态事件；事件不包含提示词或对话正文"
    hide-create hide-edit hide-delete
    :columns="[
      { key: 'instance', label: '实例' },
      { key: 'kind', label: '事件类型' },
      { key: 'severity', label: '级别' },
      { key: 'code', label: '代码' },
      { key: 'summary', label: '摘要' },
      { key: 'occurredAt', label: '发生时间', kind: 'date' }
    ]"
    :fields="[]" :list="list" :create="noopCreate" :update="noopUpdate" :remove="noopDelete"
  />
</template>
