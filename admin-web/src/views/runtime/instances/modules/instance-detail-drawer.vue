<script setup lang="ts">
import { computed } from 'vue';
import type { RuntimeInstance } from '@/service/runtime';
import { deriveRuntimeStatus } from '@/service/runtime';

defineOptions({ name: 'RuntimeInstanceDetailDrawer' });

const props = defineProps<{
  instance?: RuntimeInstance;
  show: boolean;
}>();

defineEmits<{ (event: 'update:show', value: boolean): void }>();

const status = computed(() => (props.instance ? deriveRuntimeStatus(props.instance) : 'offline'));

function pretty(value: unknown) {
  if (value === undefined || value === null) return '—';
  return JSON.stringify(value, null, 2);
}
</script>

<template>
  <NDrawer :show="show" :width="640" @update:show="value => $emit('update:show', value)">
    <NDrawerContent title="实例详情" closable>
      <NDescriptions v-if="instance" bordered label-placement="left" :column="2">
        <NDescriptionsItem label="实例名称">{{ instance.name || '—' }}</NDescriptionsItem>
        <NDescriptionsItem label="实例类型">{{ instance.instanceType || '—' }}</NDescriptionsItem>
        <NDescriptionsItem label="连接状态">
          <NTag :type="status === 'online' ? 'success' : status === 'pending' ? 'warning' : 'default'">
            {{ status }}
          </NTag>
        </NDescriptionsItem>
        <NDescriptionsItem label="版本">{{ instance.version || '—' }}</NDescriptionsItem>
        <NDescriptionsItem label="系统">{{ instance.os || '—' }}</NDescriptionsItem>
        <NDescriptionsItem label="架构">{{ instance.arch || '—' }}</NDescriptionsItem>
        <NDescriptionsItem label="租户">{{ instance.tenantId || '—' }}</NDescriptionsItem>
        <NDescriptionsItem label="最后心跳">{{ instance.lastHeartbeatAt || '—' }}</NDescriptionsItem>
      </NDescriptions>

      <NTabs v-if="instance" class="mt-16px" type="line" animated>
        <NTabPane name="health" tab="健康摘要"><pre class="m-0 whitespace-pre-wrap break-all text-13px">{{ pretty(instance.healthSummary) }}</pre></NTabPane>
        <NTabPane name="channels" tab="连接渠道"><pre class="m-0 whitespace-pre-wrap break-all text-13px">{{ pretty(instance.channels) }}</pre></NTabPane>
        <NTabPane name="resources" tab="运行资源"><pre class="m-0 whitespace-pre-wrap break-all text-13px">{{ pretty(instance.resources) }}</pre></NTabPane>
        <NTabPane name="capabilities" tab="能力"><pre class="m-0 whitespace-pre-wrap break-all text-13px">{{ pretty(instance.capabilities) }}</pre></NTabPane>
      </NTabs>

      <NAlert class="mt-16px" type="info" :bordered="false">
        页面只展示运行状态和有界摘要，不采集提示词、对话内容或设备密钥。
      </NAlert>
    </NDrawerContent>
  </NDrawer>
</template>
