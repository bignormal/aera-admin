<script setup lang="ts">
import type { ResourceCreate, ResourceDelete, ResourceList, ResourceUpdate } from '@/components/platform/resource-crud';
import { useCapability } from '@/composables/use-capability';
import {
  createBillingResource,
  deleteBillingResource,
  listBillingResources,
  updateBillingResource
} from '@/service/billing';

defineOptions({ name: 'AnnouncementsPage' });
const { can } = useCapability();
const list: ResourceList = (query, signal) => listBillingResources('announcements', query, signal);
const create: ResourceCreate = input => createBillingResource('announcements', input);
const update: ResourceUpdate = (id, input) => updateBillingResource('announcements', id, input);
const remove: ResourceDelete = id => deleteBillingResource('announcements', id);
</script>

<template>
  <ResourceCrudPage
    title="公告运营"
    description="维护充值站和 API 产品的用户公告，数据仍由 AgentEra API 持有"
    :can-write="can('operations:write')"
    :columns="[
      { key: 'title', label: '标题' },
      { key: 'type', label: '类型' },
      { key: 'status', label: '状态' },
      { key: 'priority', label: '优先级' },
      { key: 'published_at', label: '发布时间', kind: 'date' },
      { key: 'updated_at', label: '更新时间', kind: 'date' }
    ]"
    :fields="[
      { key: 'title', label: '标题', required: true },
      { key: 'content', label: '公告内容', type: 'textarea', rows: 8, required: true },
      {
        key: 'type',
        label: '类型',
        type: 'select',
        options: [
          { label: '普通', value: 'info' },
          { label: '重要', value: 'important' },
          { label: '维护', value: 'maintenance' }
        ]
      },
      {
        key: 'status',
        label: '状态',
        type: 'select',
        options: [
          { label: '草稿', value: 'draft' },
          { label: '已发布', value: 'published' }
        ]
      },
      { key: 'priority', label: '优先级', type: 'number' },
      { key: 'starts_at', label: '开始时间' },
      { key: 'ends_at', label: '结束时间' }
    ]"
    :defaults="{ type: 'info', status: 'draft', priority: 0 }"
    :list="list"
    :create="create"
    :update="update"
    :remove="remove"
  />
</template>
