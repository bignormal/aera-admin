<script setup lang="ts">
import { computed, h, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import type { DataTableColumns } from 'naive-ui';
import { NButton, NSpace, NTag } from 'naive-ui';
import CloudUserDetailDrawer from './cloud-user-detail-drawer.vue';
import { useCapability } from '@/composables/use-capability';
import { CloudServiceError } from '@/service/cloud';
import {
  getCloudDeviceStats,
  getCloudStats,
  listCloudUsers,
  lookupCloudUser,
  type CloudDeviceStats,
  type CloudPlatformStats,
  type CloudUser,
  type CloudUserStatus
} from '@/service/cloud-users';

defineOptions({ name: 'CloudUsersPanel' });

const { can } = useCapability();
const canRead = computed(() => can('cloud:users:read'));
const loading = ref(false);
const state = ref<'empty' | 'error' | 'forbidden' | 'loading' | 'ready' | 'unavailable'>('loading');
const rows = ref<CloudUser[]>([]);
const stats = ref<CloudPlatformStats>();
const deviceStats = ref<CloudDeviceStats>();
const cursorStack = ref<string[]>([]);
const nextCursor = ref<string>();
const query = reactive<{ limit: number; status?: CloudUserStatus }>({ limit: 20 });
const lookup = reactive<{ kind: 'email' | 'phone'; value: string }>({ kind: 'email', value: '' });
const showDetail = ref(false);
const detailUserId = ref<string>();
let controller: AbortController | undefined;

const statusLabels: Record<CloudUserStatus, { label: string; type: 'default' | 'error' | 'success' | 'warning' }> = {
  active: { label: '活跃', type: 'success' },
  disabled: { label: '已禁用', type: 'error' },
  pending_deletion: { label: '待删除', type: 'warning' }
};

function date(value?: string | null) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

function identity(row: CloudUser) {
  return row.masked_email || row.masked_phone || '—';
}

function versionLabel(item: { client_version?: string; version?: string }) {
  return item.client_version || item.version || '未知版本';
}

function topSummary(items?: Array<{ count: number } & Record<string, unknown>>, labelOf?: (item: Record<string, unknown>) => string) {
  if (!items?.length) return '暂无数据';
  return items
    .slice(0, 5)
    .map(item => `${labelOf?.(item) || '未知'}：${item.count}`)
    .join(' / ');
}

const platformDistribution = computed(() => topSummary(deviceStats.value?.platforms, item => String(item.platform || '未知平台')));
const versionDistribution = computed(() => topSummary(deviceStats.value?.versions, item => versionLabel(item)));

const columns: DataTableColumns<CloudUser> = [
  {
    title: '用户 ID',
    key: 'user_id',
    minWidth: 290,
    render: row =>
      h(NButton, { text: true, type: 'primary', onClick: () => openDetail(row.user_id) }, () => row.user_id)
  },
  { title: '身份', key: 'identity', minWidth: 180, render: identity },
  {
    title: '状态',
    key: 'status',
    width: 100,
    render: row => {
      const meta = statusLabels[row.status] || { label: row.status, type: 'default' as const };
      return h(NTag, { bordered: false, type: meta.type }, () => meta.label);
    }
  },
  {
    title: '设备（活跃/总）',
    key: 'device_count',
    width: 130,
    render: row => `${row.active_device_count}/${row.device_count}`
  },
  { title: '活跃会话', key: 'active_session_count', width: 90 },
  { title: '管理修订', key: 'administrative_revision', width: 90 },
  { title: '注册时间', key: 'created_at', width: 170, render: row => date(row.created_at) },
  { title: '最近活动', key: 'last_cloud_activity_at', width: 170, render: row => date(row.last_cloud_activity_at) }
];

function openDetail(userId: string) {
  detailUserId.value = userId;
  showDetail.value = true;
}

function showError(error: unknown) {
  if (error instanceof CloudServiceError) {
    const suffix = error.requestId ? `（请求 ID：${error.requestId}）` : '';
    window.$message?.error(`${error.message}${suffix}`);
  }
}

async function loadStats() {
  try {
    const [platformStats, distributionStats] = await Promise.all([getCloudStats(), getCloudDeviceStats()]);
    stats.value = platformStats;
    deviceStats.value = distributionStats;
  } catch {
    stats.value = undefined;
    deviceStats.value = undefined;
  }
}

async function load(cursor?: string) {
  controller?.abort();
  controller = new AbortController();
  loading.value = true;
  if (!rows.value.length) state.value = 'loading';
  try {
    const result = await listCloudUsers({ cursor, limit: query.limit, status: query.status }, controller.signal);
    rows.value = result.items;
    nextCursor.value = result.next_cursor;
    state.value = rows.value.length ? 'ready' : 'empty';
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return;
    if (error instanceof CloudServiceError && error.kind === 'forbidden') state.value = 'forbidden';
    else if (error instanceof CloudServiceError && error.kind === 'backend-unavailable') state.value = 'unavailable';
    else state.value = 'error';
  } finally {
    loading.value = false;
  }
}

function search() {
  cursorStack.value = [];
  void load();
}

function nextPage() {
  if (!nextCursor.value) return;
  cursorStack.value.push(nextCursor.value);
  void load(nextCursor.value);
}

function prevPage() {
  cursorStack.value.pop();
  void load(cursorStack.value[cursorStack.value.length - 1]);
}

async function runLookup() {
  const value = lookup.value.trim();
  if (value.length < 3) {
    window.$message?.warning('请输入完整的邮箱或手机号（至少 3 个字符）');
    return;
  }
  loading.value = true;
  try {
    const user = await lookupCloudUser(lookup.kind, value);
    openDetail(user.user_id);
  } catch (error) {
    if (error instanceof CloudServiceError && error.status === 404) {
      window.$message?.warning('未找到匹配的云端用户');
    } else {
      showError(error);
    }
  } finally {
    loading.value = false;
  }
}

function refresh() {
  void loadStats();
  void load(cursorStack.value[cursorStack.value.length - 1]);
}

onMounted(() => {
  void loadStats();
  void load();
});
onBeforeUnmount(() => controller?.abort());
</script>

<template>
  <div v-if="!canRead">
    <NAlert type="warning" :show-icon="false">当前角色无权查看云端用户。</NAlert>
  </div>
  <div v-else class="flex flex-col gap-16px">
    <NGrid v-if="stats" cols="2 s:3 m:6" responsive="screen" :x-gap="12" :y-gap="12">
      <NGi><NStatistic label="用户总数" :value="stats.user_total" /></NGi>
      <NGi><NStatistic label="活跃用户" :value="stats.user_active" /></NGi>
      <NGi><NStatistic label="已禁用" :value="stats.user_disabled" /></NGi>
      <NGi><NStatistic label="待删除" :value="stats.user_pending_deletion" /></NGi>
      <NGi><NStatistic label="设备总数" :value="stats.device_total" /></NGi>
      <NGi><NStatistic label="活跃设备" :value="stats.device_active" /></NGi>
    </NGrid>

    <NGrid v-if="deviceStats" cols="1 m:2" responsive="screen" :x-gap="12" :y-gap="12">
      <NGi>
        <NCard size="small" title="设备平台分布">
          <NText depth="2">{{ platformDistribution }}</NText>
        </NCard>
      </NGi>
      <NGi>
        <NCard size="small" title="客户端版本分布">
          <NText depth="2">{{ versionDistribution }}</NText>
        </NCard>
      </NGi>
    </NGrid>

    <div class="grid grid-cols-1 gap-12px md:grid-cols-[160px_auto_160px_minmax(220px,1fr)_auto]">
      <NSelect
        v-model:value="query.status"
        clearable
        placeholder="全部状态"
        :options="[
          { label: '活跃', value: 'active' },
          { label: '已禁用', value: 'disabled' },
          { label: '待删除', value: 'pending_deletion' }
        ]"
        @update:value="search"
      />
      <NButton :loading="loading" @click="search">刷新列表</NButton>
      <NSelect
        v-model:value="lookup.kind"
        :options="[
          { label: '按邮箱查找', value: 'email' },
          { label: '按手机号查找', value: 'phone' }
        ]"
      />
      <NInput
        v-model:value="lookup.value"
        clearable
        :placeholder="lookup.kind === 'email' ? '完整邮箱地址' : '完整手机号（含国家码）'"
        @keyup.enter="runLookup"
      />
      <NButton type="primary" :loading="loading" @click="runLookup">精确查找</NButton>
    </div>

    <ResourceState :state="state">
      <template #actions><NButton @click="refresh">重试</NButton></template>
      <NDataTable
        remote
        :columns="columns"
        :data="rows"
        :loading="loading"
        :row-key="row => row.user_id"
        :scroll-x="1360"
        data-testid="cloud-users-table"
      />
      <NSpace justify="end" class="mt-12px">
        <NButton :disabled="!cursorStack.length" @click="prevPage">上一页</NButton>
        <NButton :disabled="!nextCursor" @click="nextPage">下一页</NButton>
      </NSpace>
    </ResourceState>

    <CloudUserDetailDrawer v-model:show="showDetail" :user-id="detailUserId" @changed="refresh" />
  </div>
</template>
