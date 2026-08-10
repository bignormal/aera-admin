<script setup lang="ts">
import { computed, h, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import type { DataTableColumns } from 'naive-ui';
import { NButton, NCard, NDataTable, NInput, NSelect, NSpace, NTag } from 'naive-ui';
import InstanceDetailDrawer from './modules/instance-detail-drawer.vue';
import ResourcePageShell from '@/components/platform/resource-page-shell.vue';
import ResourceState from '@/components/platform/resource-state.vue';
import { useCapability } from '@/composables/use-capability';
import { CloudServiceError } from '@/service/cloud';
import { requestHealthCheck } from '@/service/cloud-desktop-control';
import {
  listRuntimeInstances,
  type RuntimeInstance,
  type RuntimeInstanceQuery
} from '@/service/runtime';

defineOptions({ name: 'RuntimeInstancesPage' });

const { can } = useCapability();
const loading = ref(false);
const state = ref<'empty' | 'error' | 'forbidden' | 'loading' | 'ready' | 'unavailable'>('loading');
const errorDescription = ref('');
const rows = ref<RuntimeInstance[]>([]);
const total = ref(0);
const query = reactive<RuntimeInstanceQuery>({
  clientVersion: undefined,
  deviceId: undefined,
  effectiveStatus: undefined,
  limit: 10,
  organizationId: undefined,
  page: 1,
  platform: undefined,
  search: '',
  sort: '-lastHeartbeatAt',
  userId: undefined
});
const showDetail = ref(false);
const selected = ref<RuntimeInstance>();
const selectedCommandId = ref<string>();
let controller: AbortController | undefined;

const pagination = computed(() => ({
  page: query.page,
  pageSize: query.limit,
  itemCount: total.value,
  showSizePicker: true,
  pageSizes: [10, 20, 50],
  onChange(page: number) {
    query.page = page;
    void load();
  },
  onUpdatePageSize(limit: number) {
    query.page = 1;
    query.limit = limit;
    void load();
  }
}));

function statusTag(row: RuntimeInstance) {
  const status = row.status || 'offline';
  const type = status === 'online' ? 'success' : status === 'pending' ? 'warning' : 'default';
  const label = { disabled: '已停用', offline: '离线', online: '在线', pending: '待激活' }[status] || status;
  return h(NTag, { bordered: false, 'data-testid': 'desktop-online-status', type }, () => label);
}

function openDetail(row: RuntimeInstance, commandId?: string) {
  selected.value = row;
  selectedCommandId.value = commandId;
  showDetail.value = true;
}

async function runHealthCheck(row: RuntimeInstance) {
  const deviceId = row.deviceId || row.id;
  if (!deviceId) return;
  try {
    const command = await requestHealthCheck(String(deviceId));
    window.$message?.success(`健康检查已进入队列：${command.command_id}`);
    openDetail(row, command.command_id);
  } catch (error) {
    if (error instanceof CloudServiceError) {
      const suffix = error.requestId ? `（请求 ID：${error.requestId}）` : '';
      window.$message?.error(`${error.message}${suffix}`);
    } else if (error instanceof Error) window.$message?.error(error.message);
  }
}

const columns: DataTableColumns<RuntimeInstance> = [
  { title: 'Desktop 名称', key: 'name', minWidth: 160 },
  { title: '设备 ID', key: 'deviceId', minWidth: 290, ellipsis: { tooltip: true } },
  { title: '用户 ID', key: 'userId', minWidth: 290, ellipsis: { tooltip: true } },
  { title: '平台 / 架构', key: 'platform', width: 150, render: row => [row.os, row.arch].filter(Boolean).join(' / ') || '—' },
  { title: '状态', key: 'status', width: 100, render: statusTag },
  { title: '版本', key: 'version', width: 110, render: row => row.version || '—' },
  {
    title: '最后心跳',
    key: 'lastHeartbeatAt',
    width: 180,
    render: row => (row.lastHeartbeatAt ? new Date(row.lastHeartbeatAt).toLocaleString('zh-CN') : '—')
  },
  {
    title: '操作',
    key: 'actions',
    fixed: 'right',
    width: 180,
    render: row =>
      h(NSpace, { size: 12 }, () => [
        h(NButton, { text: true, type: 'primary', onClick: () => openDetail(row) }, () => '详情'),
        can('runtime:command:create') &&
        row.status === 'online' &&
        Array.isArray(row.capabilities) &&
        row.capabilities.includes('diagnostics.health.read')
          ? h(NButton, { text: true, type: 'success', onClick: () => runHealthCheck(row) }, () => '健康检查')
          : null
      ])
  }
];

function normalizeSearch() {
  const value = query.search?.trim();
  query.deviceId = undefined;
  query.userId = undefined;
  if (value && /^[0-9a-f-]{36}$/.test(value)) query.deviceId = value;
}

async function load() {
  controller?.abort();
  controller = new AbortController();
  normalizeSearch();
  loading.value = true;
  errorDescription.value = '';
  if (!rows.value.length) state.value = 'loading';
  try {
    const result = await listRuntimeInstances(query, controller.signal);
    rows.value = result.docs;
    total.value = result.totalDocs;
    state.value = rows.value.length ? 'ready' : 'empty';
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return;
    if (error instanceof CloudServiceError) {
      const suffix = error.requestId ? `（请求 ID：${error.requestId}）` : '';
      errorDescription.value = `${error.message}${suffix}`;
      if (error.kind === 'forbidden') state.value = 'forbidden';
      else if (error.kind === 'backend-unavailable') state.value = 'unavailable';
      else state.value = 'error';
    } else {
      state.value = 'error';
    }
  } finally {
    loading.value = false;
  }
}

function search() {
  query.page = 1;
  void load();
}

onMounted(load);
onBeforeUnmount(() => controller?.abort());
</script>

<template>
  <ResourcePageShell title="运行实例" description="查看 Cloud 中真实登录的 Desktop 终端在线状态与健康结果">
    <template #filters>
      <div class="grid grid-cols-1 gap-8px md:grid-cols-3 lg:grid-cols-6">
        <NInput v-model:value="query.search" clearable placeholder="设备 ID / 用户 ID" @keyup.enter="search" />
        <NInput v-model:value="query.organizationId" clearable placeholder="组织 ID" @keyup.enter="search" />
        <NSelect
          v-model:value="query.platform"
          clearable
          placeholder="全部平台"
          :options="[
            { label: 'macOS', value: 'darwin' },
            { label: 'Windows', value: 'windows' },
            { label: 'Linux', value: 'linux' }
          ]"
          @update:value="search"
        />
        <NInput v-model:value="query.clientVersion" clearable placeholder="客户端版本" @keyup.enter="search" />
        <NSelect
          v-model:value="query.effectiveStatus"
          clearable
          placeholder="全部在线状态"
          :options="[
            { label: '在线', value: 'online' },
            { label: '离线', value: 'offline' },
            { label: '待激活', value: 'pending' },
            { label: '已停用', value: 'disabled' },
            { label: '已撤销', value: 'revoked' }
          ]"
          @update:value="search"
        />
        <NButton :loading="loading" type="primary" secondary @click="search">刷新</NButton>
      </div>
    </template>

    <NCard :bordered="false" class="card-wrapper">
      <ResourceState :state="state" :description="errorDescription">
        <template #actions><NButton @click="load">重试</NButton></template>
        <div class="max-w-full overflow-x-auto">
          <NDataTable
            remote
            :columns="columns"
            :data="rows"
            :loading="loading"
            :pagination="pagination"
            :row-key="row => row.id"
            :scroll-x="1500"
            data-testid="cloud-desktop-instances-table"
          />
        </div>
      </ResourceState>
    </NCard>

    <InstanceDetailDrawer
      v-model:show="showDetail"
      :instance="selected"
      :health-command-id="selectedCommandId"
    />
  </ResourcePageShell>
</template>
