<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { createOperationsPoller } from '@/service/operations';

defineOptions({ name: 'OperationsTrafficPage' });

const state = ref<'error' | 'loading' | 'ready' | 'unavailable'>('loading');
const data = ref<Record<string, unknown>>({});
const values = computed(() => Object.entries(data.value));
const poller = createOperationsPoller(
  'getOpsRealtimeTraffic',
  5_000,
  value => {
    data.value = value;
    state.value = 'ready';
  },
  () => {
    state.value = 'unavailable';
  }
);

onMounted(poller.start);
onBeforeUnmount(poller.dispose);
</script>

<template>
  <ResourcePageShell title="实时流量" description="使用单实例 HTTP 轮询查看实时流量；离开页面会自动停止请求">
    <ResourceState :state="state">
      <NGrid cols="1 s:2 l:3" responsive="screen" :x-gap="16" :y-gap="16">
        <NGridItem v-for="[key, value] in values" :key="key">
          <NCard :bordered="false" class="card-wrapper">
            <NStatistic :label="key" :value="typeof value === 'object' ? JSON.stringify(value) : String(value)" />
          </NCard>
        </NGridItem>
      </NGrid>
      <NEmpty v-if="!values.length" description="暂无实时流量数据" />
    </ResourceState>
  </ResourcePageShell>
</template>
