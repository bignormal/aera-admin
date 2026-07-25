<script setup lang="ts">
import type { ResourceCreate, ResourceDelete, ResourceList, ResourceUpdate } from '@/components/platform/resource-crud';
import { useCapability } from '@/composables/use-capability';
import { createPlugin, deletePlugin, listPlugins, updatePlugin, type PluginInput } from '@/service/plugins';
import { publishResource, saveResourceDraft } from '@/service/publishing';

defineOptions({ name: 'PluginsPage' });

const installOptions = [
  { label: '独立插件包', value: 'standalone_plugin' },
  { label: 'Python 包入口', value: 'pip_entry_point' },
  { label: 'Runtime 内置', value: 'runtime_bundled' }
];
const riskOptions = [
  { label: '低', value: 'low' },
  { label: '中', value: 'medium' },
  { label: '高', value: 'high' }
];
const { can } = useCapability();
const list: ResourceList = async (query, signal) => {
  const result = await listPlugins(query, signal);
  return { ...result, docs: result.docs.map(item => ({ ...item })) };
};
const create: ResourceCreate = input => createPlugin(input as unknown as PluginInput);
const update: ResourceUpdate = (id, input) => updatePlugin(id, input as Partial<PluginInput>);
const remove: ResourceDelete = deletePlugin;
</script>

<template>
  <ResourceCrudPage
    title="官方插件"
    description="只保存官方插件发布索引、制品校验和与兼容信息"
    :can-write="can('content:plugins:write')"
    :can-publish="can('content:plugins:publish')"
    :columns="[
      { key: 'name', label: '名称' },
      { key: 'slug', label: '稳定标识' },
      { key: 'version', label: '版本' },
      { key: 'installKind', label: '安装方式', options: installOptions },
      { key: 'riskLevel', label: '风险', options: riskOptions },
      { key: '_status', label: '状态', kind: 'status' },
      { key: 'enabled', label: '启用', kind: 'boolean' }
    ]"
    :fields="[
      { key: 'name', label: '名称', required: true },
      { key: 'slug', label: '稳定标识', required: true },
      { key: 'version', label: '版本', required: true, placeholder: '1.0.0' },
      { key: 'summary', label: '说明', type: 'textarea', required: true },
      { key: 'installKind', label: '安装方式', type: 'select', options: installOptions, required: true },
      { key: 'artifactURL', label: '制品 URL', required: true },
      { key: 'checksum', label: 'SHA-256 校验和', required: true },
      { key: 'riskLevel', label: '风险级别', type: 'select', options: riskOptions, required: true },
      { key: 'enabled', label: '启用', type: 'switch' }
    ]"
    :defaults="{ _status: 'draft', enabled: true, installKind: 'standalone_plugin', riskLevel: 'low' }"
    :list="list"
    :create="create"
    :update="update"
    :remove="remove"
    :publish="id => publishResource('plugin-catalog', id)"
    :unpublish="id => saveResourceDraft('plugin-catalog', id)"
  />
</template>
