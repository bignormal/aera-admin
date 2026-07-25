<script setup lang="ts">
import type {
  ResourceCreate,
  ResourceDelete,
  ResourceList,
  ResourceRowAction,
  ResourceUpdate
} from '@/components/platform/resource-crud';
import { useCapability } from '@/composables/use-capability';
import { cancelUsageCleanupTask, listOperationalResources } from '@/service/operations';

defineOptions({ name: 'OperationsUsageLogsPage' });

const { can } = useCapability();
const usage: ResourceList = (query, signal) => listOperationalResources('usage', query, signal);
const logs: ResourceList = (query, signal) => listOperationalResources('systemLogs', query, signal);
const cleanupTasks: ResourceList = (query, signal) => listOperationalResources('cleanupTasks', query, signal);
const noopCreate: ResourceCreate = async () => undefined;
const noopUpdate: ResourceUpdate = async () => undefined;
const noopDelete: ResourceDelete = async () => undefined;
const cleanupActions: ResourceRowAction[] = [
  { label: '取消任务', type: 'warning', handler: row => cancelUsageCleanupTask(row.id) }
];
</script>

<template>
  <ResourcePageShell title="用量与日志" description="查看平台用量、系统日志和清理任务；原始认证信息不会进入页面">
    <NTabs type="line" animated>
      <NTabPane name="usage" tab="用量明细">
        <ResourceCrudPage
          title="用量明细"
          hide-create
          hide-edit
          hide-delete
          :columns="[
            { key: 'user_email', label: '用户' },
            { key: 'model', label: '模型' },
            { key: 'tokens', label: 'Token' },
            { key: 'cost', label: '成本' },
            { key: 'created_at', label: '时间', kind: 'date' }
          ]"
          :fields="[]"
          :list="usage"
          :create="noopCreate"
          :update="noopUpdate"
          :remove="noopDelete"
        />
      </NTabPane>
      <NTabPane name="logs" tab="系统日志">
        <ResourceCrudPage
          title="系统日志"
          hide-create
          hide-edit
          hide-delete
          :columns="[
            { key: 'level', label: '级别' },
            { key: 'module', label: '模块' },
            { key: 'message', label: '内容' },
            { key: 'created_at', label: '时间', kind: 'date' }
          ]"
          :fields="[]"
          :list="logs"
          :create="noopCreate"
          :update="noopUpdate"
          :remove="noopDelete"
        />
      </NTabPane>
      <NTabPane name="cleanup" tab="清理任务">
        <ResourceCrudPage
          title="清理任务"
          :can-write="can('operations:write')"
          hide-create
          hide-edit
          hide-delete
          :columns="[
            { key: 'type', label: '类型' },
            { key: 'status', label: '状态' },
            { key: 'progress', label: '进度' },
            { key: 'created_at', label: '创建时间', kind: 'date' }
          ]"
          :fields="[]"
          :list="cleanupTasks"
          :create="noopCreate"
          :update="noopUpdate"
          :remove="noopDelete"
          :row-actions="cleanupActions"
        />
      </NTabPane>
    </NTabs>
  </ResourcePageShell>
</template>
