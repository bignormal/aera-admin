<script setup lang="ts">
import { computed, ref } from 'vue';
import type {
  ResourceCreate,
  ResourceDelete,
  ResourceList,
  ResourceRowAction,
  ResourceUpdate
} from '@/components/platform/resource-crud';
import { useCapability } from '@/composables/use-capability';
import {
  clearAccountRateLimit,
  createAIResource,
  deleteAIResource,
  getAccountModels,
  getAccountStats,
  getAccountTodayStats,
  getScheduledTestResults,
  listAIResources,
  recoverAccountState,
  refreshAccount,
  resetAccountQuota,
  syncAccountModels,
  testAccount,
  updateAIResource
} from '@/service/ai-resources';

defineOptions({ name: 'AIResourceAccountsPage' });
const { can } = useCapability();
const list: ResourceList = (query, signal) => listAIResources('accounts', query, signal);
const create: ResourceCreate = input => createAIResource('accounts', input);
const update: ResourceUpdate = (id, input) => updateAIResource('accounts', id, input);
const remove: ResourceDelete = id => deleteAIResource('accounts', id);
const detailTitle = ref('账号详情');
const detailLoading = ref(false);
const detailVisible = ref(false);
const detailStats = ref<unknown>();
const detailTodayStats = ref<unknown>();
const detailModels = ref<unknown>();
const detailScheduledResults = ref<unknown>();

const detailJSON = computed(() =>
  JSON.stringify(
    {
      stats: detailStats.value,
      todayStats: detailTodayStats.value,
      models: detailModels.value,
      scheduledTestResults: detailScheduledResults.value
    },
    null,
    2
  )
);

async function showAccountDetail(row: { id: string | number; name?: unknown }) {
  detailTitle.value = `账号详情：${String(row.name || row.id)}`;
  detailVisible.value = true;
  detailLoading.value = true;
  try {
    const [stats, todayStats, models, scheduledResults] = await Promise.allSettled([
      getAccountStats(row.id),
      getAccountTodayStats(row.id),
      getAccountModels(row.id),
      getScheduledTestResults(row.id, { page: 1, limit: 10 })
    ]);
    detailStats.value = stats.status === 'fulfilled' ? stats.value : { error: '账号统计暂不可用' };
    detailTodayStats.value = todayStats.status === 'fulfilled' ? todayStats.value : { error: '今日统计暂不可用' };
    detailModels.value = models.status === 'fulfilled' ? models.value : { error: '模型列表暂不可用' };
    detailScheduledResults.value = scheduledResults.status === 'fulfilled' ? scheduledResults.value : { error: '定时测试结果暂不可用' };
  } finally {
    detailLoading.value = false;
  }
}

const actions: ResourceRowAction[] = [
  { label: '详情', type: 'info', handler: row => showAccountDetail(row) },
  { label: '连通测试', type: 'primary', handler: row => testAccount(row.id) },
  { label: '刷新凭据', type: 'warning', handler: row => refreshAccount(row.id) },
  { label: '恢复状态', type: 'success', handler: row => recoverAccountState(row.id) },
  { label: '清限速', type: 'warning', handler: row => clearAccountRateLimit(row.id) },
  { label: '重置额度', type: 'error', handler: row => resetAccountQuota(row.id) },
  { label: '同步模型', type: 'primary', handler: row => syncAccountModels(row.id) }
];
const platformOptions = ['anthropic', 'openai', 'gemini', 'antigravity', 'grok'].map(value => ({
  label: value,
  value
}));
const typeOptions = ['oauth', 'setup-token', 'apikey', 'upstream', 'bedrock', 'service_account'].map(value => ({
  label: value,
  value
}));
</script>

<template>
  <ResourceCrudPage
    title="上游账号"
    description="管理模型上游账号与调度参数；凭据只写不回显"
    :can-write="can('ai-resources:write')"
    :columns="[
      { key: 'name', label: '账号名称' },
      { key: 'platform', label: '平台', options: platformOptions },
      { key: 'type', label: '认证方式', options: typeOptions },
      { key: 'concurrency', label: '并发' },
      { key: 'current_concurrency', label: '当前负载' },
      {
        key: 'status',
        label: '状态',
        options: [
          { label: '启用', value: 'active' },
          { label: '停用', value: 'inactive' },
          { label: '异常', value: 'error' }
        ]
      }
    ]"
    :fields="[
      { key: 'name', label: '账号名称', required: true },
      { key: 'platform', label: '平台', type: 'select', options: platformOptions, required: true },
      { key: 'type', label: '认证方式', type: 'select', options: typeOptions, required: true },
      {
        key: 'status',
        label: '状态',
        type: 'select',
        options: [
          { label: '启用', value: 'active' },
          { label: '停用', value: 'inactive' }
        ]
      },
      { key: 'notes', label: '备注', type: 'textarea' },
      { key: 'concurrency', label: '并发上限', type: 'number' },
      { key: 'priority', label: '调度优先级', type: 'number' },
      { key: 'rate_multiplier', label: '成本倍率', type: 'number' },
      { key: 'group_ids', label: '所属分组 ID JSON', type: 'json' },
      {
        key: 'credentials',
        label: '新凭据 JSON',
        type: 'json',
        writeOnly: true,
        placeholder: '编辑留空表示不替换凭据'
      },
      { key: 'extra', label: '高级参数 JSON', type: 'json' }
    ]"
    :defaults="{
      platform: 'anthropic',
      type: 'oauth',
      status: 'active',
      concurrency: 1,
      priority: 0,
      rate_multiplier: 1
    }"
    :list="list"
    :create="create"
    :update="update"
    :remove="remove"
    :row-actions="actions"
  />

  <NModal v-model:show="detailVisible" preset="card" :title="detailTitle" class="w-760px max-w-[calc(100vw-32px)]">
    <NSpin :show="detailLoading">
      <NAlert type="info" :show-icon="false" class="mb-12px">
        包含账号统计、今日统计、模型列表与最近 10 条定时测试结果；单个上游失败不会影响其它区块展示。
      </NAlert>
      <NCode :code="detailJSON" language="json" word-wrap />
    </NSpin>
  </NModal>
</template>
