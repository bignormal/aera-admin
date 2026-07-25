<script setup lang="ts">
import type { ResourceCreate, ResourceDelete, ResourceList, ResourceUpdate } from '@/components/platform/resource-crud';
import { listRuntimeOperations } from '@/service/runtime';

defineOptions({ name: 'RuntimeOperationsPage' });
const noopCreate: ResourceCreate = async () => undefined;
const noopUpdate: ResourceUpdate = async () => undefined;
const noopDelete: ResourceDelete = async () => undefined;
const lists = {
  tasks: ((query, signal) => listRuntimeOperations('tasks', query, signal)) as ResourceList,
  workflows: ((query, signal) => listRuntimeOperations('workflows', query, signal)) as ResourceList,
  cron: ((query, signal) => listRuntimeOperations('cron', query, signal)) as ResourceList,
  codingAgents: ((query, signal) => listRuntimeOperations('codingAgents', query, signal)) as ResourceList,
  devices: ((query, signal) => listRuntimeOperations('devices', query, signal)) as ResourceList
};
</script>

<template>
  <ResourcePageShell title="运行资源" description="聚合实例主动上报的有界运行摘要，不远程读取工作区或会话内容">
    <NTabs type="line" animated>
      <NTabPane name="tasks" tab="任务">
        <ResourceCrudPage title="任务" hide-create hide-edit hide-delete :columns="[{ key: 'id', label: '资源标识' }, { key: 'instanceName', label: '实例' }, { key: 'status', label: '状态' }, { key: 'source', label: '来源' }, { key: 'model', label: '模型' }, { key: 'tokens', label: 'Token' }, { key: 'cost', label: '成本' }, { key: 'errorCode', label: '错误码' }]" :fields="[]" :list="lists.tasks" :create="noopCreate" :update="noopUpdate" :remove="noopDelete" />
      </NTabPane>
      <NTabPane name="workflows" tab="工作流">
        <ResourceCrudPage title="工作流" hide-create hide-edit hide-delete :columns="[{ key: 'id', label: '资源标识' }, { key: 'instanceName', label: '实例' }, { key: 'status', label: '状态' }, { key: 'version', label: '版本' }, { key: 'nodeCount', label: '节点数' }, { key: 'failedNode', label: '失败节点' }]" :fields="[]" :list="lists.workflows" :create="noopCreate" :update="noopUpdate" :remove="noopDelete" />
      </NTabPane>
      <NTabPane name="cron" tab="定时任务">
        <ResourceCrudPage title="定时任务" hide-create hide-edit hide-delete :columns="[{ key: 'id', label: '资源标识' }, { key: 'instanceName', label: '实例' }, { key: 'status', label: '状态' }, { key: 'nextRunAt', label: '下次执行', kind: 'date' }, { key: 'lastResult', label: '最近结果' }]" :fields="[]" :list="lists.cron" :create="noopCreate" :update="noopUpdate" :remove="noopDelete" />
      </NTabPane>
      <NTabPane name="codingAgents" tab="编码智能体">
        <ResourceCrudPage title="编码智能体" hide-create hide-edit hide-delete :columns="[{ key: 'id', label: '资源标识' }, { key: 'instanceName', label: '实例' }, { key: 'type', label: '类型' }, { key: 'status', label: '状态' }, { key: 'durationMs', label: '耗时（ms）' }, { key: 'changeCount', label: '变更数' }, { key: 'workspaceHash', label: '工作区匿名标识' }]" :fields="[]" :list="lists.codingAgents" :create="noopCreate" :update="noopUpdate" :remove="noopDelete" />
      </NTabPane>
      <NTabPane name="devices" tab="设备">
        <ResourceCrudPage title="设备" hide-create hide-edit hide-delete :columns="[{ key: 'id', label: '资源标识' }, { key: 'instanceName', label: '实例' }, { key: 'type', label: '类型' }, { key: 'status', label: '状态' }, { key: 'lastSeenAt', label: '最后活动', kind: 'date' }]" :fields="[]" :list="lists.devices" :create="noopCreate" :update="noopUpdate" :remove="noopDelete" />
      </NTabPane>
    </NTabs>
  </ResourcePageShell>
</template>
