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
  createAIResource,
  deleteAIResource,
  listAIResources,
  runAIResourceAction,
  updateAIResource
} from '@/service/ai-resources';

defineOptions({ name: 'AIResourceProxiesPage' });
const { can } = useCapability();
const list: ResourceList = (query, signal) => listAIResources('proxies', query, signal);
const create: ResourceCreate = input => createAIResource('proxies', input);
const update: ResourceUpdate = (id, input) => updateAIResource('proxies', id, input);
const remove: ResourceDelete = id => deleteAIResource('proxies', id);
const actions: ResourceRowAction[] = [
  { label: '连通测试', type: 'primary', handler: row => runAIResourceAction('testProxy', row.id) },
  { label: '质量检测', type: 'warning', handler: row => runAIResourceAction('checkProxyQuality', row.id) }
];
const protocolOptions = ['http', 'https', 'socks5', 'socks5h'].map(value => ({ label: value, value }));
</script>

<template>
  <ResourceCrudPage
    title="代理节点"
    description="维护模型账号使用的代理与故障回退；密码只写不回显"
    :can-write="can('ai-resources:write')"
    :columns="[
      { key: 'name', label: '节点名称' },
      { key: 'protocol', label: '协议', options: protocolOptions },
      { key: 'host', label: '主机' },
      { key: 'port', label: '端口' },
      { key: 'country', label: '出口地区' },
      { key: 'latency_ms', label: '延迟 ms' },
      {
        key: 'status',
        label: '状态',
        options: [
          { label: '启用', value: 'active' },
          { label: '停用', value: 'inactive' },
          { label: '过期', value: 'expired' }
        ]
      }
    ]"
    :fields="[
      { key: 'name', label: '节点名称', required: true },
      { key: 'protocol', label: '协议', type: 'select', options: protocolOptions, required: true },
      { key: 'host', label: '主机', required: true },
      { key: 'port', label: '端口', type: 'number', required: true },
      { key: 'username', label: '用户名' },
      { key: 'password', label: '新密码', type: 'password', writeOnly: true, placeholder: '编辑留空表示不修改' },
      {
        key: 'status',
        label: '状态',
        type: 'select',
        options: [
          { label: '启用', value: 'active' },
          { label: '停用', value: 'inactive' }
        ]
      },
      {
        key: 'fallback_mode',
        label: '回退策略',
        type: 'select',
        options: [
          { label: '不回退', value: 'none' },
          { label: '备用代理', value: 'proxy' },
          { label: '直连', value: 'direct' }
        ]
      },
      { key: 'backup_proxy_id', label: '备用代理 ID', type: 'number' }
    ]"
    :defaults="{ protocol: 'http', status: 'active', fallback_mode: 'none' }"
    :list="list"
    :create="create"
    :update="update"
    :remove="remove"
    :row-actions="actions"
  />
</template>
