<script setup lang="ts">
import { computed, h, onBeforeUnmount, reactive, ref, watch } from 'vue';
import type { DataTableColumns } from 'naive-ui';
import { NButton, NCard, NDataTable, NTag } from 'naive-ui';
import ResourceState from '@/components/platform/resource-state.vue';
import { useCapability } from '@/composables/use-capability';
import { CloudServiceError } from '@/service/cloud';
import {
  desktopHealthCodeLabels,
  getDesktopCommand,
  listUserDesktopInstances,
  requestHealthCheck,
  type DesktopCommand,
  type DesktopEffectiveStatus,
  type DesktopInstance
} from '@/service/cloud-desktop-control';

defineOptions({ name: 'CloudUserDesktopPanel' });

const props = defineProps<{ userId: string }>();
const { can } = useCapability();
const canRead = computed(() => can('runtime:read'));
const canCommand = computed(() => can('runtime:command:create'));
const state = ref<'empty' | 'error' | 'forbidden' | 'loading' | 'ready' | 'unavailable'>('loading');
const rows = ref<DesktopInstance[]>([]);
const commands = reactive<Record<string, DesktopCommand | undefined>>({});
const commandLoading = reactive<Record<string, boolean | undefined>>({});
const pollControllers = new Map<string, AbortController>();
const pollTimers = new Map<string, ReturnType<typeof setTimeout>>();
let listController: AbortController | undefined;

const statusLabels: Record<
  DesktopEffectiveStatus,
  { label: string; type: 'default' | 'error' | 'success' | 'warning' }
> = {
  pending: { label: '待激活', type: 'warning' },
  revoked: { label: '已撤销', type: 'error' },
  disabled: { label: '用户已禁用', type: 'error' },
  online: { label: '在线', type: 'success' },
  offline: { label: '离线', type: 'default' }
};

const commandStateLabels: Record<DesktopCommand['state'], string> = {
  queued: '已排队',
  claimed: '已领取',
  running: '执行中',
  succeeded: '已完成',
  failed: '失败',
  expired: '已过期'
};

function date(value?: string | null) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(value)
  );
}

function stopPolling(deviceId: string) {
  const timer = pollTimers.get(deviceId);
  if (timer) clearTimeout(timer);
  pollTimers.delete(deviceId);
  pollControllers.get(deviceId)?.abort();
  pollControllers.delete(deviceId);
}

function stopAll() {
  listController?.abort();
  for (const deviceId of pollTimers.keys()) stopPolling(deviceId);
  for (const controller of pollControllers.values()) controller.abort();
  pollControllers.clear();
}

function terminal(command: DesktopCommand) {
  return command.state === 'succeeded' || command.state === 'failed' || command.state === 'expired';
}

function schedulePoll(deviceId: string, commandId: string, attempt = 0) {
  if (attempt >= 60) return;
  const timer = setTimeout(async () => {
    const controller = pollControllers.get(deviceId);
    if (!controller || controller.signal.aborted) return;
    try {
      const next = await getDesktopCommand(commandId, controller.signal);
      commands[deviceId] = next;
      if (terminal(next)) {
        stopPolling(deviceId);
        return;
      }
      schedulePoll(deviceId, commandId, attempt + 1);
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      stopPolling(deviceId);
      showError(error);
    }
  }, 1000);
  pollTimers.set(deviceId, timer);
}

function showError(error: unknown) {
  if (error instanceof CloudServiceError) {
    const suffix = error.requestId ? `（请求 ID：${error.requestId}）` : '';
    window.$message?.error(`${error.message}${suffix}`);
  } else if (error instanceof Error) {
    window.$message?.error(error.message);
  }
}

async function load() {
  stopAll();
  if (!canRead.value) {
    state.value = 'forbidden';
    return;
  }
  listController = new AbortController();
  state.value = 'loading';
  try {
    const result = await listUserDesktopInstances(
      props.userId,
      { limit: 50, offset: 0 },
      listController.signal
    );
    rows.value = [...result.items];
    state.value = rows.value.length ? 'ready' : 'empty';
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return;
    if (error instanceof CloudServiceError && error.kind === 'forbidden') state.value = 'forbidden';
    else if (error instanceof CloudServiceError && error.kind === 'backend-unavailable') {
      state.value = 'unavailable';
    } else state.value = 'error';
  }
}

async function runHealthCheck(row: DesktopInstance) {
  stopPolling(row.device_id);
  commandLoading[row.device_id] = true;
  try {
    const command = await requestHealthCheck(row.device_id);
    commands[row.device_id] = command;
    if (!terminal(command)) {
      pollControllers.set(row.device_id, new AbortController());
      schedulePoll(row.device_id, command.command_id);
    }
  } catch (error) {
    showError(error);
  } finally {
    commandLoading[row.device_id] = false;
  }
}

function healthText(row: DesktopInstance) {
  const command = commands[row.device_id];
  if (command) {
    const code = command.result_code;
    const label = code ? desktopHealthCodeLabels[code] : commandStateLabels[command.state];
    return `${commandStateLabels[command.state]}${code ? ` · ${code} · ${label}` : ''}`;
  }
  const code = row.health_summary?.code;
  return code ? `${code} · ${desktopHealthCodeLabels[code]}` : row.health_status;
}

const columns: DataTableColumns<DesktopInstance> = [
  { title: 'Desktop', key: 'display_name', minWidth: 150, ellipsis: { tooltip: true } },
  { title: '平台', key: 'platform', width: 90 },
  { title: '版本', key: 'client_version', width: 100 },
  {
    title: '在线状态',
    key: 'effective_status',
    width: 110,
    render: row => {
      const meta = statusLabels[row.effective_status];
      return h(
        NTag,
        { bordered: false, 'data-testid': 'desktop-online-status', type: meta.type },
        () => meta.label
      );
    }
  },
  { title: '最近心跳', key: 'last_heartbeat_at', width: 170, render: row => date(row.last_heartbeat_at) },
  {
    title: '健康状态',
    key: 'health',
    minWidth: 210,
    render: row => {
      const command = commands[row.device_id];
      return h(
        'span',
        { 'data-testid': command && terminal(command) ? 'desktop-health-result' : undefined },
        healthText(row)
      );
    }
  },
  {
    title: '操作',
    key: 'actions',
    width: 100,
    render: row =>
      canCommand.value &&
      row.effective_status === 'online' &&
      row.capabilities.includes('diagnostics.health.read')
        ? h(
            NButton,
            {
              loading: Boolean(commandLoading[row.device_id]),
              text: true,
              type: 'success',
              onClick: () => runHealthCheck(row)
            },
            () => '健康检查'
          )
        : '—'
  }
];

watch(() => props.userId, load, { immediate: true });
onBeforeUnmount(stopAll);
</script>

<template>
  <NCard size="small" title="Desktop 终端" :bordered="false">
    <ResourceState :state="state" description="该用户尚无已登录并上报心跳的 Desktop。">
      <template #actions><NButton @click="load">重试</NButton></template>
      <NDataTable
        remote
        :columns="columns"
        :data="rows"
        :row-key="row => row.device_id"
        size="small"
        :scroll-x="1020"
        data-testid="cloud-user-desktop-table"
      />
    </ResourceState>
  </NCard>
</template>
