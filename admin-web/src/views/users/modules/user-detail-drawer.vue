<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { PlatformServiceError } from '@/service/platform';
import {
  getUser,
  getUserAPIKeys,
  getUserAttributes,
  getUserBalanceHistory,
  getUserPlatformQuotas,
  getUserRPMStatus,
  getUserSubscriptions,
  getUserUsage,
  type PlatformUser
} from '@/service/users';

defineOptions({ name: 'UserDetailDrawer' });

const props = defineProps<{ show: boolean; userId?: number }>();
const emit = defineEmits<{ 'update:show': [value: boolean] }>();

type DetailSection = 'apiKeys' | 'attributes' | 'balanceHistory' | 'quotas' | 'rpm' | 'subscriptions' | 'usage';

const loading = ref(false);
const error = ref<PlatformServiceError>();
const user = ref<PlatformUser>();
const details = ref<Record<DetailSection, unknown>>({
  apiKeys: undefined,
  attributes: undefined,
  balanceHistory: undefined,
  quotas: undefined,
  rpm: undefined,
  subscriptions: undefined,
  usage: undefined
});

const title = computed(() => user.value?.email || '用户详情');

function pretty(value: unknown) {
  return JSON.stringify(value ?? {}, null, 2);
}

async function load() {
  if (!props.userId) return;
  loading.value = true;
  error.value = undefined;
  try {
    const [currentUser, apiKeys, usage, history, rpm, quotas, attributes, subscriptions] = await Promise.all([
      getUser(props.userId),
      getUserAPIKeys(props.userId),
      getUserUsage(props.userId),
      getUserBalanceHistory(props.userId),
      getUserRPMStatus(props.userId),
      getUserPlatformQuotas(props.userId),
      getUserAttributes(props.userId),
      getUserSubscriptions(props.userId)
    ]);
    user.value = currentUser;
    details.value = {
      apiKeys,
      attributes,
      balanceHistory: history,
      quotas,
      rpm,
      subscriptions,
      usage
    };
  } catch (caught) {
    if (caught instanceof PlatformServiceError) error.value = caught;
  } finally {
    loading.value = false;
  }
}

watch(
  () => [props.show, props.userId] as const,
  ([show]) => {
    if (show) void load();
  }
);
</script>

<template>
  <NDrawer :show="show" :width="760" placement="right" @update:show="value => emit('update:show', value)">
    <NDrawerContent :title="title" closable>
      <div v-if="loading" class="flex min-h-240px items-center justify-center"><NSpin size="large" /></div>
      <NResult
        v-else-if="error"
        status="error"
        title="用户详情加载失败"
        :description="`${error.message}${error.requestId ? `（请求 ID：${error.requestId}）` : ''}`"
      >
        <template #footer><NButton @click="load">重试</NButton></template>
      </NResult>
      <NSpace v-else-if="user" vertical :size="16">
        <NDescriptions bordered label-placement="left" :column="2">
          <NDescriptionsItem label="用户 ID">{{ user.id }}</NDescriptionsItem>
          <NDescriptionsItem label="状态">
            <NTag :type="user.status === 'active' ? 'success' : 'default'" :bordered="false">
              {{ user.status === 'active' ? '启用' : '停用' }}
            </NTag>
          </NDescriptionsItem>
          <NDescriptionsItem label="用户名">{{ user.username || '—' }}</NDescriptionsItem>
          <NDescriptionsItem label="角色">{{ user.role }}</NDescriptionsItem>
          <NDescriptionsItem label="余额">{{ Number(user.balance).toFixed(4) }}</NDescriptionsItem>
          <NDescriptionsItem label="并发 / RPM">
            {{ user.concurrency }} / {{ user.rpm_limit || '不限' }}
          </NDescriptionsItem>
          <NDescriptionsItem label="备注" :span="2">{{ user.notes || '—' }}</NDescriptionsItem>
        </NDescriptions>

        <NTabs type="line" animated>
          <NTabPane name="usage" tab="用量"><NCode :code="pretty(details.usage)" language="json" word-wrap /></NTabPane>
          <NTabPane name="keys" tab="API Keys">
            <NAlert type="info" :bordered="false" class="mb-12px">密钥原文不会由管理后台请求或展示。</NAlert>
            <NCode :code="pretty(details.apiKeys)" language="json" word-wrap />
          </NTabPane>
          <NTabPane name="balance" tab="余额记录">
            <NCode :code="pretty(details.balanceHistory)" language="json" word-wrap />
          </NTabPane>
          <NTabPane name="quota" tab="配额与订阅">
            <NCode
              :code="pretty({ rpm: details.rpm, quotas: details.quotas, subscriptions: details.subscriptions })"
              language="json"
              word-wrap
            />
          </NTabPane>
          <NTabPane name="attributes" tab="用户属性">
            <NCode :code="pretty(details.attributes)" language="json" word-wrap />
          </NTabPane>
        </NTabs>
      </NSpace>
    </NDrawerContent>
  </NDrawer>
</template>
