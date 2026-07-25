<script setup lang="ts">
import type {
  ResourceCreate,
  ResourceDelete,
  ResourceList,
  ResourceRowAction,
  ResourceUpdate
} from '@/components/platform/resource-crud';
import { useCapability } from '@/composables/use-capability';
import { listOperationalResources, resolveRequestError, resolveUpstreamError } from '@/service/operations';

defineOptions({ name: 'OperationsDiagnosticsPage' });

const { can } = useCapability();
const noopCreate: ResourceCreate = async () => undefined;
const noopUpdate: ResourceUpdate = async () => undefined;
const noopDelete: ResourceDelete = async () => undefined;
const requestErrors: ResourceList = (query, signal) => listOperationalResources('requestErrors', query, signal);
const upstreamErrors: ResourceList = (query, signal) => listOperationalResources('upstreamErrors', query, signal);
const requestDetails: ResourceList = (query, signal) => listOperationalResources('requestDetails', query, signal);
const requestActions: ResourceRowAction[] = [
  { label: '标记解决', type: 'success', handler: row => resolveRequestError(row.id) }
];
const upstreamActions: ResourceRowAction[] = [
  { label: '标记解决', type: 'success', handler: row => resolveUpstreamError(row.id) }
];
const diagnosticColumns = [
  { key: 'requestId', label: '请求 ID' },
  { key: 'model', label: '模型' },
  { key: 'channel', label: '渠道' },
  { key: 'status', label: '状态' },
  { key: 'latencyMs', label: '延迟（ms）' },
  { key: 'errorCode', label: '错误码' },
  { key: 'errorSummary', label: '错误摘要' },
  { key: 'occurredAt', label: '发生时间', kind: 'date' as const }
];
</script>

<template>
  <ResourcePageShell title="请求诊断" description="仅展示脱敏后的结构化诊断摘要，不暴露请求正文、响应正文或认证头">
    <NTabs type="line" animated>
      <NTabPane name="request-errors" tab="请求错误">
        <ResourceCrudPage
          title="请求错误"
          :can-write="can('operations:write')"
          hide-create
          hide-edit
          hide-delete
          :columns="diagnosticColumns"
          :fields="[]"
          :list="requestErrors"
          :create="noopCreate"
          :update="noopUpdate"
          :remove="noopDelete"
          :row-actions="requestActions"
        />
      </NTabPane>
      <NTabPane name="upstream-errors" tab="上游错误">
        <ResourceCrudPage
          title="上游错误"
          :can-write="can('operations:write')"
          hide-create
          hide-edit
          hide-delete
          :columns="diagnosticColumns"
          :fields="[]"
          :list="upstreamErrors"
          :create="noopCreate"
          :update="noopUpdate"
          :remove="noopDelete"
          :row-actions="upstreamActions"
        />
      </NTabPane>
      <NTabPane name="requests" tab="请求明细">
        <ResourceCrudPage
          title="请求明细"
          hide-create
          hide-edit
          hide-delete
          :columns="diagnosticColumns"
          :fields="[]"
          :list="requestDetails"
          :create="noopCreate"
          :update="noopUpdate"
          :remove="noopDelete"
        />
      </NTabPane>
    </NTabs>
  </ResourcePageShell>
</template>
