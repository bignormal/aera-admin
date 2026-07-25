<script setup lang="ts">
import type { ResourceCreate, ResourceDelete, ResourceList, ResourceUpdate } from '@/components/platform/resource-crud';
import { useCapability } from '@/composables/use-capability';
import {
  createBillingResource,
  deleteBillingResource,
  listBillingResources,
  updateBillingResource
} from '@/service/billing';

defineOptions({ name: 'BillingPlansPage' });
const { can } = useCapability();
const list: ResourceList = (query, signal) => listBillingResources('plans', query, signal);
const create: ResourceCreate = input => createBillingResource('plans', input);
const update: ResourceUpdate = (id, input) => updateBillingResource('plans', id, input);
const remove: ResourceDelete = id => deleteBillingResource('plans', id);
</script>

<template>
  <ResourceCrudPage
    title="套餐管理"
    description="维护充值站现有套餐、价格、额度和启停状态"
    :can-write="can('billing:write')"
    :columns="[
      { key: 'name', label: '套餐名称' },
      { key: 'price', label: '售价' },
      { key: 'amount', label: '到账额度' },
      { key: 'currency', label: '币种' },
      { key: 'sort_order', label: '排序' },
      { key: 'enabled', label: '启用', kind: 'boolean' }
    ]"
    :fields="[
      { key: 'name', label: '套餐名称', required: true },
      { key: 'description', label: '说明', type: 'textarea' },
      { key: 'price', label: '售价（按上游精度）', required: true },
      { key: 'amount', label: '到账额度', required: true },
      { key: 'currency', label: '币种', required: true },
      { key: 'enabled', label: '启用', type: 'switch' },
      { key: 'sort_order', label: '排序', type: 'number' },
      { key: 'metadata', label: '扩展配置 JSON', type: 'json' }
    ]"
    :defaults="{ currency: 'CNY', enabled: true, sort_order: 0 }"
    :list="list"
    :create="create"
    :update="update"
    :remove="remove"
  />
</template>
