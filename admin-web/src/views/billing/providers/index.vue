<script setup lang="ts">
import type { ResourceCreate, ResourceDelete, ResourceList, ResourceUpdate } from '@/components/platform/resource-crud';
import { listBillingResources } from '@/service/billing';

defineOptions({ name: 'BillingProvidersPage' });
const list: ResourceList = (query, signal) => listBillingResources('providers', query, signal);
const noopCreate: ResourceCreate = async () => undefined;
const noopUpdate: ResourceUpdate = async () => undefined;
const noopDelete: ResourceDelete = async () => undefined;
</script>

<template>
  <ResourceCrudPage
    title="支付渠道"
    description="只读查看 Provider 状态与脱敏配置；密钥修改等待高风险重新验证能力"
    :columns="[
      { key: 'name', label: '渠道名称' },
      { key: 'type', label: '类型' },
      { key: 'enabled', label: '启用', kind: 'boolean' },
      { key: 'status', label: '连通状态' },
      { key: 'updated_at', label: '更新时间', kind: 'date' }
    ]"
    :fields="[]"
    :list="list"
    :create="noopCreate"
    :update="noopUpdate"
    :remove="noopDelete"
  />
</template>
