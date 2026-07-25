<script setup lang="ts">
import type { ResourceCreate, ResourceDelete, ResourceList, ResourceRowAction, ResourceUpdate } from '@/components/platform/resource-crud';
import { useCapability } from '@/composables/use-capability';
import {
  clearGroupRPMOverrides,
  clearGroupRateMultipliers,
  createAIResource,
  deleteAIResource,
  getGroupRateMultipliers,
  getGroupStats,
  listAIResources,
  updateAIResource,
  updateGroupRPMOverrides,
  updateGroupRateMultipliers
} from '@/service/ai-resources';

defineOptions({ name: 'AIResourceGroupsPage' });
const { can } = useCapability();
const list: ResourceList = (query, signal) => listAIResources('groups', query, signal);
const create: ResourceCreate = input => createAIResource('groups', input);
const update: ResourceUpdate = (id, input) => updateAIResource('groups', id, input);
const remove: ResourceDelete = id => deleteAIResource('groups', id);
const platformOptions = ['anthropic', 'openai', 'gemini', 'antigravity', 'grok'].map(value => ({
  label: value,
  value
}));

function parseJSONInput(value: string | null, fallback: Record<string, unknown>) {
  if (value === null) return undefined;
  if (!value.trim()) return fallback;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid');
    return parsed as Record<string, unknown>;
  } catch {
    window.$message?.warning('请输入合法 JSON 对象。');
    return undefined;
  }
}

const rowActions: ResourceRowAction[] = [
  {
    label: '统计',
    type: 'info',
    async handler(row) {
      const stats = await getGroupStats(row.id);
      window.$dialog?.info({
        title: `分组统计：${String(row.name || row.id)}`,
        content: JSON.stringify(stats, null, 2),
        positiveText: '关闭'
      });
    }
  },
  {
    label: '倍率',
    type: 'warning',
    async handler(row) {
      const current = await getGroupRateMultipliers(row.id).catch(() => ({}));
      const input = parseJSONInput(window.prompt('请输入倍率 JSON 对象', JSON.stringify(current, null, 2)), {});
      if (!input) return;
      await updateGroupRateMultipliers(row.id, input);
    }
  },
  {
    label: '清倍率',
    type: 'error',
    handler: row => clearGroupRateMultipliers(row.id)
  },
  {
    label: 'RPM 覆盖',
    type: 'warning',
    async handler(row) {
      const input = parseJSONInput(window.prompt('请输入 RPM 覆盖 JSON 对象', '{}'), {});
      if (!input) return;
      await updateGroupRPMOverrides(row.id, input);
    }
  },
  {
    label: '清 RPM',
    type: 'error',
    handler: row => clearGroupRPMOverrides(row.id)
  }
];
</script>

<template>
  <ResourceCrudPage
    title="模型分组"
    description="维护模型平台、计费倍率、用户 RPM 和订阅额度"
    :can-write="can('ai-resources:write')"
    :columns="[
      { key: 'name', label: '分组名称' },
      { key: 'platform', label: '平台', options: platformOptions },
      { key: 'rate_multiplier', label: '倍率' },
      { key: 'rpm_limit', label: 'RPM' },
      { key: 'account_count', label: '账号数' },
      {
        key: 'status',
        label: '状态',
        options: [
          { label: '启用', value: 'active' },
          { label: '停用', value: 'inactive' }
        ]
      }
    ]"
    :fields="[
      { key: 'name', label: '分组名称', required: true },
      { key: 'platform', label: '模型平台', type: 'select', options: platformOptions, required: true },
      { key: 'description', label: '说明', type: 'textarea' },
      {
        key: 'status',
        label: '状态',
        type: 'select',
        options: [
          { label: '启用', value: 'active' },
          { label: '停用', value: 'inactive' }
        ]
      },
      { key: 'rate_multiplier', label: '计费倍率', type: 'number' },
      { key: 'rpm_limit', label: 'RPM 上限（0 不限）', type: 'number' },
      { key: 'is_exclusive', label: '专属分组', type: 'switch' },
      { key: 'daily_limit_usd', label: '每日额度 USD', type: 'number' },
      { key: 'weekly_limit_usd', label: '每周额度 USD', type: 'number' },
      { key: 'monthly_limit_usd', label: '每月额度 USD', type: 'number' },
      { key: 'model_routing', label: '模型路由 JSON', type: 'json' }
    ]"
    :defaults="{ platform: 'anthropic', status: 'active', rate_multiplier: 1, rpm_limit: 0, is_exclusive: false }"
    :list="list"
    :create="create"
    :update="update"
    :remove="remove"
    :row-actions="rowActions"
  />
</template>
