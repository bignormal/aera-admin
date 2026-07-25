<script setup lang="ts">
import type {
  ResourceCreate,
  ResourceDelete,
  ResourceList,
  ResourceRowAction,
  ResourceUpdate
} from '@/components/platform/resource-crud';
import { useCapability } from '@/composables/use-capability';
import {
  createAlertRule,
  deleteAlertRule,
  listOperationalResources,
  updateAlertEventStatus,
  updateAlertRule
} from '@/service/operations';

defineOptions({ name: 'OperationsAlertsPage' });

const { can } = useCapability();
const rules: ResourceList = (query, signal) => listOperationalResources('alertRules', query, signal);
const events: ResourceList = (query, signal) => listOperationalResources('alertEvents', query, signal);
const create: ResourceCreate = input => createAlertRule(input);
const update: ResourceUpdate = (id, input) => updateAlertRule(id, input);
const remove: ResourceDelete = id => deleteAlertRule(id);
const noopCreate: ResourceCreate = async () => undefined;
const noopUpdate: ResourceUpdate = async () => undefined;
const noopDelete: ResourceDelete = async () => undefined;
const eventActions: ResourceRowAction[] = [
  { label: '标记解决', type: 'success', handler: row => updateAlertEventStatus(row.id) }
];
</script>

<template>
  <ResourcePageShell title="告警中心" description="统一维护告警规则并处理 AgentEra API 产生的告警事件">
    <NTabs type="line" animated>
      <NTabPane name="rules" tab="告警规则">
        <ResourceCrudPage
          title="告警规则"
          :can-write="can('operations:write')"
          :columns="[
            { key: 'name', label: '规则名称' },
            { key: 'metric', label: '指标' },
            { key: 'operator', label: '条件' },
            { key: 'threshold', label: '阈值' },
            { key: 'severity', label: '级别' },
            { key: 'enabled', label: '启用', kind: 'boolean' }
          ]"
          :fields="[
            { key: 'name', label: '规则名称', required: true },
            { key: 'metric', label: '指标', required: true },
            { key: 'operator', label: '比较条件', required: true },
            { key: 'threshold', label: '阈值', required: true, type: 'number' },
            { key: 'severity', label: '级别', required: true },
            { key: 'enabled', label: '启用', type: 'switch' }
          ]"
          :defaults="{ enabled: true, severity: 'warning' }"
          :list="rules"
          :create="create"
          :update="update"
          :remove="remove"
        />
      </NTabPane>
      <NTabPane name="events" tab="告警事件">
        <ResourceCrudPage
          title="告警事件"
          :can-write="can('operations:write')"
          hide-create
          hide-edit
          hide-delete
          :columns="[
            { key: 'rule_name', label: '规则' },
            { key: 'severity', label: '级别' },
            { key: 'status', label: '状态' },
            { key: 'message', label: '信息' },
            { key: 'created_at', label: '发生时间', kind: 'date' }
          ]"
          :fields="[]"
          :list="events"
          :create="noopCreate"
          :update="noopUpdate"
          :remove="noopDelete"
          :row-actions="eventActions"
        />
      </NTabPane>
    </NTabs>
  </ResourcePageShell>
</template>
