<script setup lang="ts">
import type { ResourceCreate, ResourceDelete, ResourceList, ResourceUpdate } from '@/components/platform/resource-crud';
import { listAuditLogs } from '@/service/audit';

defineOptions({ name: 'AuditPage' });
const list: ResourceList = (query, signal) => listAuditLogs(query, signal);
const noopCreate: ResourceCreate = async () => undefined;
const noopUpdate: ResourceUpdate = async () => undefined;
const noopDelete: ResourceDelete = async () => undefined;
</script>

<template>
  <ResourceCrudPage
    title="审计中心"
    description="只读查看管理员登录、内容变更、业务操作和运行时控制记录；敏感字段已由服务端脱敏"
    hide-create
    hide-edit
    hide-delete
    :columns="[
      { key: 'occurredAt', label: '发生时间', kind: 'date', width: 180 },
      { key: 'actorEmail', label: '操作者', width: 200 },
      { key: 'action', label: '动作', width: 210 },
      { key: 'resourceType', label: '资源类型', width: 150 },
      { key: 'resourceName', label: '资源' },
      { key: 'outcome', label: '结果', options: [{ label: '成功', value: 'succeeded' }, { label: '失败', value: 'failed' }] },
      { key: 'errorCode', label: '错误码' },
      { key: 'requestId', label: '请求 ID', width: 260 }
    ]"
    :fields="[]"
    :list="list"
    :create="noopCreate"
    :update="noopUpdate"
    :remove="noopDelete"
  />
</template>
