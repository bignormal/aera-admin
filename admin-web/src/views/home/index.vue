<script setup lang="ts">
import * as echarts from 'echarts';
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { useCapability } from '@/composables/use-capability';
import { getBillingOverview } from '@/service/billing';
import { getCloudStats, type CloudPlatformStats } from '@/service/cloud-users';
import { ApiError } from '@/service/http';
import { getOperationalSnapshot } from '@/service/operations';
import {
  getPlatformReadiness,
  getPlatformStatus,
  type PlatformDomainReadiness,
  type PlatformReadiness,
  type PlatformStatus
} from '@/service/platform';
import { useAuthStore } from '@/store/modules/auth';

const loading = ref(false);
const status = ref<PlatformStatus>();
const state = ref<'error' | 'loading' | 'ready' | 'unavailable'>('loading');
const authStore = useAuthStore();
const { can } = useCapability();
const readiness = ref<PlatformReadiness>();
const readinessError = ref('');
const readinessLoading = ref(false);
const billingOverview = ref<Record<string, unknown>>();
const cloudStats = ref<CloudPlatformStats>();
const opsOverview = ref<Record<string, unknown>>();
const throughputTrend = ref<unknown[]>([]);
const errorTrend = ref<unknown[]>([]);
const errorDistribution = ref<unknown[]>([]);
const latencyHistogram = ref<unknown[]>([]);
const dashboardError = ref('');
const throughputChart = ref<HTMLDivElement>();
const errorTrendChart = ref<HTMLDivElement>();
const errorDistributionChart = ref<HTMLDivElement>();
const latencyChart = ref<HTMLDivElement>();
const chartInstances: echarts.ECharts[] = [];

const canBillingRead = computed(() => can('billing:read'));
const canCloudRead = computed(() => can('cloud:users:read'));
const canOpsRead = computed(() => can('operations:read'));

const apiStatus = computed(() => status.value?.data.agenteraAPI.status || 'not_configured');
const apiLabel = computed(() => {
  if (apiStatus.value === 'healthy') return '健康';
  if (apiStatus.value === 'unavailable') return '不可用';
  return '未配置';
});
const apiTagType = computed(() => {
  if (apiStatus.value === 'healthy') return 'success';
  if (apiStatus.value === 'unavailable') return 'error';
  return 'warning';
});

const cloudStatus = computed(() => status.value?.data.aeraCloud?.status || 'not_configured');
const cloudLabel = computed(() => {
  if (cloudStatus.value === 'healthy') return '健康';
  if (cloudStatus.value === 'unavailable') return '不可用';
  return '未配置';
});
const cloudTagType = computed(() => {
  if (cloudStatus.value === 'healthy') return 'success';
  if (cloudStatus.value === 'unavailable') return 'error';
  return 'warning';
});

function metric(source: Record<string, unknown> | undefined, keys: string[], fallback = '—') {
  for (const key of keys) {
    const value = source?.[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value.toLocaleString('zh-CN');
    if (typeof value === 'string' && value.trim()) return value;
  }
  return fallback;
}

function numberMetric(source: Record<string, unknown> | undefined, keys: string[]) {
  for (const key of keys) {
    const value = source?.[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  }
  return undefined;
}

function records(value: unknown): Array<Record<string, unknown>> {
  const candidate = Array.isArray(value)
    ? value
    : value && typeof value === 'object'
      ? ((value as Record<string, unknown>).items ??
        (value as Record<string, unknown>).data ??
        (value as Record<string, unknown>).points ??
        (value as Record<string, unknown>).buckets)
      : [];
  return Array.isArray(candidate) ? candidate.filter(item => item && typeof item === 'object') as Array<Record<string, unknown>> : [];
}

function labelOf(item: Record<string, unknown>, index: number) {
  return String(item.time ?? item.label ?? item.name ?? item.bucket ?? item.error_code ?? item.status ?? index + 1);
}

function valueOf(item: Record<string, unknown>) {
  const value = item.value ?? item.count ?? item.total ?? item.requests ?? item.qps ?? item.latency_ms;
  return typeof value === 'number' && Number.isFinite(value) ? value : Number(value) || 0;
}

function resetCharts() {
  while (chartInstances.length) chartInstances.pop()?.dispose();
}

function renderLineChart(el: HTMLDivElement | undefined, title: string, data: unknown[], color: string) {
  if (!el) return;
  const rows = records(data);
  const chart = echarts.init(el);
  chart.setOption({
    color: [color],
    grid: { bottom: 32, left: 44, right: 16, top: 36 },
    title: { left: 0, text: title, textStyle: { fontSize: 13 } },
    tooltip: { trigger: 'axis' },
    xAxis: { boundaryGap: false, data: rows.map(labelOf), type: 'category' },
    yAxis: { type: 'value' },
    series: [{ data: rows.map(valueOf), smooth: true, type: 'line' }]
  });
  chartInstances.push(chart);
}

function renderBarChart(el: HTMLDivElement | undefined, title: string, data: unknown[]) {
  if (!el) return;
  const rows = records(data);
  const chart = echarts.init(el);
  chart.setOption({
    color: ['#6366f1'],
    grid: { bottom: 32, left: 44, right: 16, top: 36 },
    title: { left: 0, text: title, textStyle: { fontSize: 13 } },
    tooltip: { trigger: 'axis' },
    xAxis: { data: rows.map(labelOf), type: 'category' },
    yAxis: { type: 'value' },
    series: [{ data: rows.map(valueOf), type: 'bar' }]
  });
  chartInstances.push(chart);
}

function renderPieChart(el: HTMLDivElement | undefined, title: string, data: unknown[]) {
  if (!el) return;
  const rows = records(data);
  const chart = echarts.init(el);
  chart.setOption({
    title: { left: 0, text: title, textStyle: { fontSize: 13 } },
    tooltip: { trigger: 'item' },
    series: [
      {
        data: rows.map((item, index) => ({ name: labelOf(item, index), value: valueOf(item) })),
        radius: ['40%', '70%'],
        type: 'pie'
      }
    ]
  });
  chartInstances.push(chart);
}

async function renderCharts() {
  await nextTick();
  resetCharts();
  if (!canOpsRead.value) return;
  renderLineChart(throughputChart.value, '吞吐趋势', throughputTrend.value, '#22c55e');
  renderLineChart(errorTrendChart.value, '错误趋势', errorTrend.value, '#ef4444');
  renderPieChart(errorDistributionChart.value, '错误分布', errorDistribution.value);
  renderBarChart(latencyChart.value, '延迟直方图', latencyHistogram.value);
}

async function loadDashboard() {
  dashboardError.value = '';
  const tasks: Promise<unknown>[] = [];
  if (canBillingRead.value) tasks.push(getBillingOverview().then(value => (billingOverview.value = value)));
  if (canCloudRead.value) tasks.push(getCloudStats().then(value => (cloudStats.value = value)));
  if (canOpsRead.value) {
    tasks.push(getOperationalSnapshot('getOpsDashboardOverview').then(value => (opsOverview.value = value)));
    tasks.push(getOperationalSnapshot('getOpsThroughputTrend').then(value => (throughputTrend.value = records(value))));
    tasks.push(getOperationalSnapshot('getOpsErrorTrend').then(value => (errorTrend.value = records(value))));
    tasks.push(getOperationalSnapshot('getOpsErrorDistribution').then(value => (errorDistribution.value = records(value))));
    tasks.push(getOperationalSnapshot('getOpsLatencyHistogram').then(value => (latencyHistogram.value = records(value))));
  }
  const results = await Promise.allSettled(tasks);
  if (results.some(item => item.status === 'rejected')) dashboardError.value = '部分业务指标暂不可用，请稍后刷新。';
  await renderCharts();
}

async function load() {
  loading.value = true;
  state.value = 'loading';
  try {
    status.value = await getPlatformStatus();
    state.value = 'ready';
    await loadDashboard();
  } catch (error) {
    state.value = error instanceof ApiError && error.status === 0 ? 'unavailable' : 'error';
  } finally {
    loading.value = false;
  }
}

function readinessTagType(domain: PlatformDomainReadiness) {
  return domain.status === 'healthy' ? 'success' : 'error';
}

async function validateResources() {
  readinessLoading.value = true;
  readinessError.value = '';
  readiness.value = undefined;
  try {
    readiness.value = await getPlatformReadiness();
  } catch (error) {
    readinessError.value = error instanceof ApiError ? error.message : '真实资源验证失败';
  } finally {
    readinessLoading.value = false;
  }
}

onMounted(load);
onBeforeUnmount(resetCharts);
</script>

<template>
  <div data-testid="agentera-admin-shell">
    <ResourcePageShell title="AgentEra 平台总览" description="统一查看 Payload 内容后台、AgentEra API、Aera Cloud 与关键业务指标">
      <template #actions><NButton :loading="loading" @click="load">刷新状态</NButton></template>
      <ResourceState :state="state">
        <template #actions><NButton @click="load">重试</NButton></template>
        <NGrid :x-gap="16" :y-gap="16" cols="1 m:3" responsive="screen">
          <NGridItem>
            <NCard :bordered="false" class="card-wrapper">
              <NSpace vertical :size="12">
                <div class="flex-y-center justify-between">
                  <span class="text-16px font-600">Payload 管理服务</span>
                  <NTag type="success" :bordered="false">健康</NTag>
                </div>
                <p class="m-0 text-14px text-gray-500">管理员、官方内容、审计与 BFF 正常响应。</p>
              </NSpace>
            </NCard>
          </NGridItem>
          <NGridItem>
            <NCard :bordered="false" class="card-wrapper">
              <NSpace vertical :size="12">
                <div class="flex-y-center justify-between">
                  <span class="text-16px font-600">AgentEra API / 充值业务</span>
                  <NTag :type="apiTagType" :bordered="false">{{ apiLabel }}</NTag>
                </div>
                <p class="m-0 text-14px text-gray-500">
                  {{ status?.data.agenteraAPI.errorCode || `探测耗时 ${status?.data.agenteraAPI.latencyMs || 0} ms` }}
                </p>
              </NSpace>
            </NCard>
          </NGridItem>
          <NGridItem>
            <NCard :bordered="false" class="card-wrapper">
              <NSpace vertical :size="12">
                <div class="flex-y-center justify-between">
                  <span class="text-16px font-600">Aera Cloud / 云端管控</span>
                  <NTag :type="cloudTagType" :bordered="false">{{ cloudLabel }}</NTag>
                </div>
                <p class="m-0 text-14px text-gray-500">
                  {{ status?.data.aeraCloud?.errorCode || `探测耗时 ${status?.data.aeraCloud?.latencyMs || 0} ms` }}
                </p>
              </NSpace>
            </NCard>
          </NGridItem>
        </NGrid>

        <NAlert v-if="dashboardError" type="warning" :show-icon="false" class="mt-16px">{{ dashboardError }}</NAlert>

        <NGrid :x-gap="16" :y-gap="16" cols="1 m:3" responsive="screen" class="mt-16px">
          <NGridItem v-if="canBillingRead">
            <NCard :bordered="false" class="card-wrapper">
              <template #header>商业概览</template>
              <NSpace vertical :size="8">
                <div class="flex-y-center justify-between"><span>今日营收</span><NText strong>{{ metric(billingOverview, ['today_revenue', 'todayRevenue', 'revenue_today']) }}</NText></div>
                <div class="flex-y-center justify-between"><span>今日订单</span><NText strong>{{ metric(billingOverview, ['today_orders', 'todayOrders', 'order_count']) }}</NText></div>
                <div class="flex-y-center justify-between"><span>支付成功率</span><NText strong>{{ metric(billingOverview, ['success_rate', 'successRate']) }}</NText></div>
              </NSpace>
            </NCard>
          </NGridItem>
          <NGridItem v-if="canCloudRead">
            <NCard :bordered="false" class="card-wrapper">
              <template #header>云端用户</template>
              <NSpace vertical :size="8">
                <div class="flex-y-center justify-between"><span>总用户</span><NText strong>{{ cloudStats?.user_total?.toLocaleString('zh-CN') || '—' }}</NText></div>
                <div class="flex-y-center justify-between"><span>活跃设备</span><NText strong>{{ cloudStats?.device_active?.toLocaleString('zh-CN') || '—' }}</NText></div>
                <div class="flex-y-center justify-between"><span>禁用用户</span><NText strong>{{ cloudStats?.user_disabled?.toLocaleString('zh-CN') || '—' }}</NText></div>
              </NSpace>
            </NCard>
          </NGridItem>
          <NGridItem v-if="canOpsRead">
            <NCard :bordered="false" class="card-wrapper">
              <template #header>运营态势</template>
              <NSpace vertical :size="8">
                <div class="flex-y-center justify-between"><span>QPS</span><NText strong>{{ metric(opsOverview, ['qps', 'requests_per_second']) }}</NText></div>
                <div class="flex-y-center justify-between"><span>错误率</span><NText strong>{{ metric(opsOverview, ['error_rate', 'errorRate']) }}</NText></div>
                <div class="flex-y-center justify-between"><span>P95 延迟</span><NText strong>{{ numberMetric(opsOverview, ['p95_latency_ms', 'p95LatencyMs']) ?? '—' }} ms</NText></div>
              </NSpace>
            </NCard>
          </NGridItem>
        </NGrid>

        <NGrid v-if="canOpsRead" :x-gap="16" :y-gap="16" cols="1 m:2" responsive="screen" class="mt-16px">
          <NGridItem><NCard :bordered="false" class="card-wrapper"><div ref="throughputChart" class="h-280px" /></NCard></NGridItem>
          <NGridItem><NCard :bordered="false" class="card-wrapper"><div ref="errorTrendChart" class="h-280px" /></NCard></NGridItem>
          <NGridItem><NCard :bordered="false" class="card-wrapper"><div ref="errorDistributionChart" class="h-280px" /></NCard></NGridItem>
          <NGridItem><NCard :bordered="false" class="card-wrapper"><div ref="latencyChart" class="h-280px" /></NCard></NGridItem>
        </NGrid>

        <NCard v-if="authStore.isStaticSuper" :bordered="false" class="card-wrapper mt-16px">
          <template #header>真实资源就绪度</template>
          <template #header-extra>
            <NButton data-testid="validate-platform-readiness" :loading="readinessLoading" @click="validateResources">
              验证真实资源
            </NButton>
          </template>
          <NAlert v-if="readinessError" type="error" :show-icon="true" class="mb-12px">
            {{ readinessError }}
          </NAlert>
          <NEmpty v-if="!readiness" description="点击“验证真实资源”检查各后台域，不会读取或展示业务数据" />
          <NTable v-else size="small" :single-line="false">
            <thead>
              <tr>
                <th>资源域</th>
                <th>状态</th>
                <th>耗时</th>
                <th>错误码</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="domain in readiness.data.domains" :key="domain.key">
                <td>{{ domain.label }}</td>
                <td>
                  <NTag :type="readinessTagType(domain)" :bordered="false">
                    {{ domain.status === 'healthy' ? '健康' : '不可用' }}
                  </NTag>
                </td>
                <td>{{ domain.latencyMs }} ms</td>
                <td>{{ domain.errorCode || '—' }}</td>
              </tr>
            </tbody>
          </NTable>
        </NCard>
      </ResourceState>
    </ResourcePageShell>
  </div>
</template>
