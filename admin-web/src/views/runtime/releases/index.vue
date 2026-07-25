<script setup lang="ts">
import type { ResourceCreate, ResourceDelete, ResourceList, ResourceUpdate } from '@/components/platform/resource-crud';
import { useCapability } from '@/composables/use-capability';
import { createRuntimeRelease, deleteRuntimeRelease, listRuntimeReleases, updateRuntimeRelease } from '@/service/runtime';

defineOptions({ name: 'RuntimeReleasesPage' });
const { can } = useCapability();
const list: ResourceList = (query, signal) => listRuntimeReleases(query, signal);
const create: ResourceCreate = input => createRuntimeRelease(input);
const update: ResourceUpdate = (id, input) => updateRuntimeRelease(id, input);
const remove: ResourceDelete = id => deleteRuntimeRelease(id);
</script>

<template>
  <ResourceCrudPage
    title="版本元数据"
    description="维护版本、下载地址和校验值；这里只登记元数据，不自动触发实例升级"
    :can-write="can('runtime:command:create')"
    :columns="[
      { key: 'product', label: '产品' },
      { key: 'version', label: '版本' },
      { key: 'channel', label: '通道' },
      { key: 'minimumVersion', label: '最低版本' },
      { key: 'status', label: '状态' },
      { key: 'publishedAt', label: '发布时间', kind: 'date' }
    ]"
    :fields="[
      { key: 'product', label: '产品', type: 'select', required: true, options: [{ label: 'Runtime', value: 'runtime' }, { label: 'Studio', value: 'studio' }, { label: '桌面端', value: 'desktop' }] },
      { key: 'version', label: '版本', required: true },
      { key: 'channel', label: '通道', type: 'select', required: true, options: [{ label: '稳定版', value: 'stable' }, { label: '测试版', value: 'beta' }, { label: '每夜版', value: 'nightly' }] },
      { key: 'minimumVersion', label: '最低兼容版本' },
      { key: 'artifactURL', label: '制品地址', required: true },
      { key: 'checksum', label: 'SHA-256 校验值', required: true },
      { key: 'publishedAt', label: '发布时间（ISO 8601）' },
      { key: 'status', label: '状态', type: 'select', required: true, options: [{ label: '草稿', value: 'draft' }, { label: '已发布', value: 'published' }, { label: '已退役', value: 'retired' }] }
    ]"
    :defaults="{ channel: 'stable', product: 'runtime', status: 'draft' }"
    :list="list"
    :create="create"
    :update="update"
    :remove="remove"
  />
</template>
