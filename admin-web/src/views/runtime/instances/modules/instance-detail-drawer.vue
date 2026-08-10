<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { NAlert, NDescriptions, NDescriptionsItem, NDrawer, NDrawerContent, NTag } from 'naive-ui';
import { getDesktopCommand, type DesktopCommand } from '@/service/cloud-desktop-control';
import type { RuntimeInstance } from '@/service/runtime';

defineOptions({ name: 'RuntimeInstanceDetailDrawer' });

const props = defineProps<{
  healthCommandId?: string;
  instance?: RuntimeInstance;
  show: boolean;
}>();

const emit = defineEmits<{ (event: 'update:show', value: boolean): void }>();
const command = ref<DesktopCommand>();
const loading = ref(false);
let controller: AbortController | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
let attempts = 0;

const status = computed(() => props.instance?.status || 'offline');
const terminal = computed(
  () =>
    command.value?.state === 'succeeded' ||
    command.value?.state === 'failed' ||
    command.value?.state === 'expired'
);

function stopPolling() {
  if (timer) clearTimeout(timer);
  timer = undefined;
  controller?.abort();
  controller = undefined;
  loading.value = false;
}

function schedule() {
  if (!props.show || !props.healthCommandId || terminal.value || attempts >= 60) return;
  timer = setTimeout(async () => {
    if (!controller || controller.signal.aborted || !props.healthCommandId) return;
    attempts += 1;
    try {
      command.value = await getDesktopCommand(props.healthCommandId, controller.signal);
      if (!terminal.value) schedule();
    } catch {
      stopPolling();
    } finally {
      loading.value = false;
    }
  }, 1000);
}

function startPolling() {
  stopPolling();
  command.value = undefined;
  attempts = 0;
  if (!props.show || !props.healthCommandId) return;
  controller = new AbortController();
  loading.value = true;
  schedule();
}

function date(value?: string | null) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(value)
  );
}

function stateLabel(value?: DesktopCommand['state']) {
  return (
    {
      claimed: '已领取',
      expired: '已过期',
      failed: '失败',
      queued: '已排队',
      running: '执行中',
      succeeded: '已完成'
    } as Record<DesktopCommand['state'], string>
  )[value || 'queued'];
}

watch(() => [props.show, props.healthCommandId] as const, startPolling, { immediate: true });
onBeforeUnmount(stopPolling);
</script>

<template>
  <NDrawer :show="show" :width="640" @update:show="value => emit('update:show', value)">
    <NDrawerContent title="Desktop 终端详情" closable>
      <NDescriptions v-if="instance" bordered label-placement="left" :column="2">
        <NDescriptionsItem label="Desktop 名称">{{ instance.name || '—' }}</NDescriptionsItem>
        <NDescriptionsItem label="连接状态">
          <NTag :type="status === 'online' ? 'success' : status === 'pending' ? 'warning' : 'default'">
            {{ status === 'online' ? '在线' : status === 'pending' ? '待激活' : status === 'disabled' ? '已停用' : '离线' }}
          </NTag>
        </NDescriptionsItem>
        <NDescriptionsItem label="设备 ID" :span="2">{{ instance.deviceId || instance.id }}</NDescriptionsItem>
        <NDescriptionsItem label="用户 ID" :span="2">{{ instance.userId || '—' }}</NDescriptionsItem>
        <NDescriptionsItem label="版本">{{ instance.version || '—' }}</NDescriptionsItem>
        <NDescriptionsItem label="系统 / 架构">{{ [instance.os, instance.arch].filter(Boolean).join(' / ') || '—' }}</NDescriptionsItem>
        <NDescriptionsItem label="最后心跳">{{ date(instance.lastHeartbeatAt) }}</NDescriptionsItem>
      </NDescriptions>

      <NAlert v-if="healthCommandId" class="mt-16px" type="info" :bordered="false">
        <template v-if="loading">正在读取 Cloud 健康检查结果…</template>
        <template v-else-if="command">
          <div data-testid="desktop-health-result">
            健康检查：{{ stateLabel(command.state) }}<span v-if="command.result_code"> · {{ command.result_code }}</span>
          </div>
          <div class="mt-4px text-13px text-gray-500">完成时间：{{ date(command.completed_at) }}</div>
        </template>
        <template v-else>暂无健康检查结果。</template>
      </NAlert>

      <NDescriptions v-if="instance" class="mt-16px" bordered label-placement="left" :column="1">
        <NDescriptionsItem label="能力">{{ Array.isArray(instance.capabilities) ? instance.capabilities.join('、') : '—' }}</NDescriptionsItem>
        <NDescriptionsItem label="健康摘要">{{ instance.healthSummary ? 'Cloud 已返回有界摘要' : '尚未执行健康检查' }}</NDescriptionsItem>
      </NDescriptions>

      <NAlert class="mt-16px" type="info" :bordered="false">
        页面只展示 Cloud 计算的在线状态和固定健康摘要，不采集提示词、对话内容、文件、日志或设备密钥。
      </NAlert>
    </NDrawerContent>
  </NDrawer>
</template>
