<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { getBillingOverview } from '@/service/billing';
import { PlatformServiceError } from '@/service/platform';

defineOptions({ name: 'BillingOverviewPage' });
const loading = ref(false);
const state = ref<'error' | 'loading' | 'ready' | 'unavailable'>('loading');
const data = ref<Record<string, unknown>>({});
const metrics = computed(() =>
  Object.entries(data.value)
    .filter(([, value]) => ['number', 'string'].includes(typeof value))
    .slice(0, 12)
);

async function load() {
  loading.value = true;
  state.value = 'loading';
  try {
    data.value = await getBillingOverview();
    state.value = 'ready';
  } catch (error) {
    state.value =
      error instanceof PlatformServiceError && error.kind === 'backend-unavailable' ? 'unavailable' : 'error';
  } finally {
    loading.value = false;
  }
}
onMounted(load);
</script>

<template>
  <ResourcePageShell title="商业总览" description="直接读取充值业务的订单、收入和履约统计，不复制账务数据">
    <template #actions><NButton :loading="loading" @click="load">刷新</NButton></template>
    <ResourceState :state="state">
      <template #actions><NButton @click="load">重试</NButton></template>
      <NGrid cols="1 s:2 l:4" responsive="screen" :x-gap="16" :y-gap="16">
        <NGridItem v-for="[key, value] in metrics" :key="key">
          <NCard :bordered="false" class="card-wrapper"><NStatistic :label="key" :value="String(value)" /></NCard>
        </NGridItem>
      </NGrid>
      <NEmpty v-if="!metrics.length" description="上游暂未返回汇总指标" />
    </ResourceState>
  </ResourcePageShell>
</template>
