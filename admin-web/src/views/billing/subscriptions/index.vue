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
  assignSubscription,
  extendSubscription,
  listBillingResources,
  resetSubscriptionQuota,
  restoreSubscription,
  revokeSubscription
} from '@/service/billing';

defineOptions({ name: 'BillingSubscriptionsPage' });
const { can } = useCapability();
const list: ResourceList = (query, signal) => listBillingResources('subscriptions', query, signal);
const create: ResourceCreate = assignSubscription;
const noopUpdate: ResourceUpdate = async () => undefined;
const noopDelete: ResourceDelete = async () => undefined;
const actions: ResourceRowAction[] = [
  { label: '延期', type: 'primary', handler: row => extendSubscription(row.id) },
  { label: '重置额度', type: 'warning', handler: row => resetSubscriptionQuota(row.id) },
  { label: '撤销', type: 'error', handler: row => revokeSubscription(row.id) },
  { label: '恢复', type: 'success', handler: row => restoreSubscription(row.id) }
];
</script>

<template>
  <ResourceCrudPage
    title="订阅管理"
    description="分配、延期、重置、撤销和恢复用户订阅"
    :can-write="can('billing:write')"
    hide-edit
    hide-delete
    :columns="[
      { key: 'id', label: 'ID' },
      { key: 'user_id', label: '用户 ID' },
      { key: 'group_id', label: '分组 ID' },
      { key: 'status', label: '状态' },
      { key: 'expires_at', label: '到期时间', kind: 'date' },
      { key: 'daily_usage_usd', label: '日用量' }
    ]"
    :fields="[
      { key: 'user_id', label: '用户 ID', type: 'number', required: true },
      { key: 'group_id', label: '分组 ID', type: 'number', required: true },
      { key: 'validity_days', label: '有效天数', type: 'number' }
    ]"
    :defaults="{ validity_days: 30 }"
    :list="list"
    :create="create"
    :update="noopUpdate"
    :remove="noopDelete"
    :row-actions="actions"
  />
</template>
