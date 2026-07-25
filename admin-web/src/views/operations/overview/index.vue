<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { createOperationsPoller, getOperationalSnapshot } from '@/service/operations';

defineOptions({ name: 'OperationsOverviewPage' });

const state = ref<'error' | 'loading' | 'ready' | 'unavailable'>('loading');
const data = ref<Record<string, unknown>>({});
const concurrency = ref<Record<string, unknown>>({});
const realtimeTraffic = ref<Record<string, unknown>>({});
const accountAvailability = ref<Record<string, unknown>>({});
const metrics = computed(() =>
  Object.entries(data.value)
    .filter(([, value]) => ['number', 'string'].includes(typeof value))
    .slice(0, 16)
);
const snapshotCards = computed(() => [
  { title: '并发快照', value: concurrency.value },
  { title: '实时流量', value: realtimeTraffic.value },
  { title: '账号可用性', value: accountAvailability.value }
]);
const poller = createOperationsPoller(
  'getOpsDashboardOverview',
  30_000,
  value => {
    data.value = value;
    state.value = 'ready';
    void loadRealtimeSnapshots();
  },
  () => {
    state.value = 'unavailable';
  }
);

async function loadRealtimeSnapshots() {
  const [nextConcurrency, nextTraffic, nextAvailability] = await Promise.allSettled([
    getOperationalSnapshot('getOpsConcurrency'),
    getOperationalSnapshot('getOpsRealtimeTraffic'),
    getOperationalSnapshot('getOpsAccountAvailability')
  ]);
  if (nextConcurrency.status === 'fulfilled') concurrency.value = nextConcurrency.value;
  if (nextTraffic.status === 'fulfilled') realtimeTraffic.value = nextTraffic.value;
  if (nextAvailability.status === 'fulfilled') accountAvailability.value = nextAvailability.value;
}

onMounted(poller.start);
onBeforeUnmount(poller.dispose);
</script>

<template>
  <ResourcePageShell title="运营总览" description="聚合并定时刷新 AgentEra API 的吞吐、并发、延迟和错误状态">
    <ResourceState :state="state">
      <template #actions><NButton @click="poller.start">重试</NButton></template>
      <NGrid cols="1 s:2 l:4" responsive="screen" :x-gap="16" :y-gap="16">
        <NGridItem v-for="[key, value] in metrics" :key="key">
          <NCard :bordered="false" class="card-wrapper">
            <NStatistic :label="key" :value="String(value)" />
          </NCard>
        </NGridItem>
      </NGrid>
      <NEmpty v-if="!metrics.length" description="上游暂未返回运营指标" />
      <NGrid cols="1 l:3" responsive="screen" :x-gap="16" :y-gap="16" class="mt-16px">
        <NGridItem v-for="card in snapshotCards" :key="card.title">
          <NCard :title="card.title" :bordered="false" class="card-wrapper">
            <NCode :code="JSON.stringify(card.value, null, 2)" language="json" word-wrap />
          </NCard>
        </NGridItem>
      </NGrid>
    </ResourceState>
  </ResourcePageShell>
</template>
