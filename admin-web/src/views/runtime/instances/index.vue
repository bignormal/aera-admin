<script setup lang="ts">
import { computed, h, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import type { DataTableColumns } from 'naive-ui';
import { NButton, NSpace, NTag } from 'naive-ui';
import InstanceDetailDrawer from './modules/instance-detail-drawer.vue';
import { useCapability } from '@/composables/use-capability';
import { ApiError } from '@/service/http';
import {
  createRuntimeCommand,
  createRuntimeEnrollment,
  deriveRuntimeStatus,
  listRuntimeInstances,
  supportsRuntimeCommand,
  type RuntimeInstance
} from '@/service/runtime';

defineOptions({ name: 'RuntimeInstancesPage' });

const { can } = useCapability();
const loading = ref(false);
const saving = ref(false);
const state = ref<'empty' | 'error' | 'loading' | 'ready' | 'unavailable'>('loading');
const rows = ref<RuntimeInstance[]>([]);
const total = ref(0);
const query = reactive({ limit: 10, page: 1, search: '', sort: '-lastHeartbeatAt' });
const showEnrollment = ref(false);
const showDetail = ref(false);
const selected = ref<RuntimeInstance>();
const enrollment = reactive({ instanceType: 'runtime' as 'desktop' | 'runtime' | 'studio', name: '', tenantId: '' });
const enrollmentCode = ref('');
const enrollmentExpiresAt = ref('');
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
  const status = deriveRuntimeStatus(row);
  const type = status === 'online' ? 'success' : status === 'pending' ? 'warning' : 'default';
  const label = { disabled: '已停用', offline: '离线', online: '在线', pending: '待注册' }[status] || status;
  return h(NTag, { bordered: false, type }, () => label);
}

function openDetail(row: RuntimeInstance) {
  selected.value = row;
  showDetail.value = true;
}

async function runHealthCheck(row: RuntimeInstance) {
  try {
    await createRuntimeCommand(row, 'health_check');
    window.$message?.success('健康检查指令已进入队列');
  } catch (error) {
    window.$message?.error(error instanceof Error ? error.message : '创建指令失败');
  }
}

const columns: DataTableColumns<RuntimeInstance> = [
  { title: '实例名称', key: 'name', minWidth: 160 },
  { title: '类型', key: 'instanceType', width: 100 },
  { title: '状态', key: 'runtimeStatus', width: 100, render: statusTag },
  { title: '版本', key: 'version', width: 120, render: row => row.version || '—' },
  { title: '系统 / 架构', key: 'platform', width: 160, render: row => [row.os, row.arch].filter(Boolean).join(' / ') || '—' },
  {
    title: '最后心跳',
    key: 'lastHeartbeatAt',
    width: 180,
    render: row => row.lastHeartbeatAt ? new Date(row.lastHeartbeatAt).toLocaleString('zh-CN') : '—'
  },
  {
    title: '操作',
    key: 'actions',
    fixed: 'right',
    width: 190,
    render: row =>
      h(NSpace, { size: 12 }, () => [
        h(NButton, { text: true, type: 'primary', onClick: () => openDetail(row) }, () => '详情'),
        can('runtime:command:create') && supportsRuntimeCommand(row, 'health_check')
          ? h(NButton, { text: true, type: 'success', onClick: () => runHealthCheck(row) }, () => '健康检查')
          : null
      ])
  }
];

async function load() {
  controller?.abort();
  controller = new AbortController();
  loading.value = true;
  if (!rows.value.length) state.value = 'loading';
  try {
    const result = await listRuntimeInstances(query, controller.signal);
    rows.value = result.docs;
    total.value = result.totalDocs;
    state.value = rows.value.length ? 'ready' : 'empty';
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return;
    state.value = error instanceof ApiError && error.status === 0 ? 'unavailable' : 'error';
  } finally {
    loading.value = false;
  }
}

function search() {
  query.page = 1;
  void load();
}

function openEnrollment() {
  Object.assign(enrollment, { instanceType: 'runtime', name: '', tenantId: '' });
  enrollmentCode.value = '';
  enrollmentExpiresAt.value = '';
  showEnrollment.value = true;
}

function closeEnrollment() {
  enrollmentCode.value = '';
  enrollmentExpiresAt.value = '';
  showEnrollment.value = false;
}

async function submitEnrollment() {
  if (!enrollment.name.trim()) {
    window.$message?.warning('请填写实例名称');
    return;
  }
  saving.value = true;
  try {
    const result = await createRuntimeEnrollment({
      instanceType: enrollment.instanceType,
      name: enrollment.name.trim(),
      ...(enrollment.tenantId.trim() ? { tenantId: enrollment.tenantId.trim() } : {})
    });
    enrollmentCode.value = result.take() || '';
    enrollmentExpiresAt.value = result.expiresAt;
    await load();
  } catch (error) {
    window.$message?.error(error instanceof Error ? error.message : '创建注册码失败');
  } finally {
    saving.value = false;
  }
}

onMounted(load);
onBeforeUnmount(() => {
  controller?.abort();
  enrollmentCode.value = '';
});
</script>

<template>
  <ResourcePageShell title="运行实例" description="管理已明确注册的 Runtime、Studio 和桌面端；默认不启用远程控制">
    <template #actions>
      <NButton v-if="can('runtime:command:create')" type="primary" @click="openEnrollment">创建注册码</NButton>
    </template>
    <template #filters>
      <div class="flex gap-8px lt-sm:flex-col">
        <NInput v-model:value="query.search" clearable placeholder="搜索实例名称" @clear="search" @keyup.enter="search" />
        <NButton :loading="loading" @click="search">搜索</NButton>
      </div>
    </template>

    <NAlert type="info" :bordered="false">
      当前仅开放只读健康检查。升级、重启和回滚属于高风险操作，在重新验证能力上线前不提供入口。
    </NAlert>

    <NCard :bordered="false" class="card-wrapper">
      <ResourceState :state="state">
        <template #actions><NButton @click="load">重试</NButton></template>
        <div class="max-w-full overflow-x-auto">
          <NDataTable
            remote
            :columns="columns"
            :data="rows"
            :loading="loading"
            :pagination="pagination"
            :row-key="row => row.id"
            :scroll-x="1100"
          />
        </div>
      </ResourceState>
    </NCard>

    <NModal :show="showEnrollment" preset="card" title="创建一次性注册码" class="w-560px max-w-[calc(100vw-32px)]" @update:show="value => !value && closeEnrollment()">
      <template v-if="enrollmentCode">
        <NAlert title="注册码只显示一次" type="warning">
          请在有效期内复制到目标客户端，关闭窗口后后台不会再次展示。
        </NAlert>
        <NInput class="mt-16px" :value="enrollmentCode" readonly type="textarea" :rows="3" />
        <p class="mb-0 text-13px text-gray-500">有效期至：{{ new Date(enrollmentExpiresAt).toLocaleString('zh-CN') }}</p>
      </template>
      <NForm v-else :model="enrollment" label-placement="top">
        <NFormItem label="实例名称" required><NInput v-model:value="enrollment.name" placeholder="例如：生产 Runtime 01" /></NFormItem>
        <NFormItem label="实例类型" required>
          <NSelect v-model:value="enrollment.instanceType" :options="[{ label: 'Runtime', value: 'runtime' }, { label: 'Studio', value: 'studio' }, { label: '桌面端', value: 'desktop' }]" />
        </NFormItem>
        <NFormItem label="租户标识（可选）"><NInput v-model:value="enrollment.tenantId" /></NFormItem>
      </NForm>
      <template #footer>
        <NSpace justify="end">
          <NButton @click="closeEnrollment">{{ enrollmentCode ? '已保存，关闭' : '取消' }}</NButton>
          <NButton v-if="!enrollmentCode" type="primary" :loading="saving" @click="submitEnrollment">生成注册码</NButton>
        </NSpace>
      </template>
    </NModal>

    <InstanceDetailDrawer v-model:show="showDetail" :instance="selected" />
  </ResourcePageShell>
</template>
