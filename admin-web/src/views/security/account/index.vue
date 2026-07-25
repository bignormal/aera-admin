<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { getCurrentAdmin, type AdminUser } from '@/service/auth';
import { getStepUpStatus, type StepUpStatus } from '@/service/security';

const loading = ref(false);
const admin = ref<AdminUser | null>(null);
const status = ref<StepUpStatus>();
const state = ref<'error' | 'loading' | 'ready' | 'unavailable'>('loading');
const showStepUp = ref(false);

const verifiedUntil = computed(() => {
  if (!status.value?.stepUpVerifiedAt) return undefined;
  const verifiedAt = Date.parse(status.value.stepUpVerifiedAt);
  if (!Number.isFinite(verifiedAt)) return undefined;
  return new Date(verifiedAt + status.value.windowSeconds * 1000);
});

const remainingSeconds = computed(() => {
  if (!verifiedUntil.value) return 0;
  return Math.max(0, Math.floor((verifiedUntil.value.getTime() - Date.now()) / 1000));
});

const stepUpLabel = computed(() => (remainingSeconds.value > 0 ? `已验证，剩余 ${remainingSeconds.value} 秒` : '未验证或已过期'));

async function load() {
  loading.value = true;
  state.value = 'loading';
  try {
    const [currentAdmin, stepUp] = await Promise.all([getCurrentAdmin(), getStepUpStatus()]);
    admin.value = currentAdmin;
    status.value = stepUp;
    state.value = 'ready';
  } catch {
    state.value = 'error';
  } finally {
    loading.value = false;
  }
}

function onStepUpVerified() {
  showStepUp.value = false;
  window.$message?.success('二次验证已完成');
  void load();
}

function onStepUpCancelled() {
  showStepUp.value = false;
}

onMounted(load);
</script>

<template>
  <ResourcePageShell title="账号安全" description="查看当前管理员身份、TOTP 绑定与高危操作二次验证窗口">
    <template #actions>
      <NButton :loading="loading" @click="load">刷新</NButton>
      <NButton type="primary" @click="showStepUp = true">
        {{ status?.totpEnabled ? '验证 StepUp' : '绑定 TOTP' }}
      </NButton>
    </template>

    <ResourceState :state="state">
      <template #actions><NButton @click="load">重试</NButton></template>
      <NGrid :x-gap="16" :y-gap="16" cols="1 m:2" responsive="screen">
        <NGridItem>
          <NCard :bordered="false" class="card-wrapper">
            <template #header>当前管理员</template>
            <NDescriptions :column="1" label-placement="left" bordered size="small">
              <NDescriptionsItem label="姓名">{{ admin?.displayName || '—' }}</NDescriptionsItem>
              <NDescriptionsItem label="邮箱">{{ admin?.email || '—' }}</NDescriptionsItem>
              <NDescriptionsItem label="角色">{{ admin?.role || '—' }}</NDescriptionsItem>
              <NDescriptionsItem label="云 Actor">
                <NText code>{{ admin?.cloudActorId || '—' }}</NText>
              </NDescriptionsItem>
            </NDescriptions>
          </NCard>
        </NGridItem>

        <NGridItem>
          <NCard :bordered="false" class="card-wrapper">
            <template #header>TOTP 与 StepUp</template>
            <NSpace vertical :size="12">
              <div class="flex-y-center justify-between">
                <span>TOTP 绑定状态</span>
                <NTag :type="status?.totpEnabled ? 'success' : 'warning'" :bordered="false">
                  {{ status?.totpEnabled ? '已绑定' : '未绑定' }}
                </NTag>
              </div>
              <div class="flex-y-center justify-between">
                <span>StepUp 状态</span>
                <NTag :type="remainingSeconds > 0 ? 'success' : 'default'" :bordered="false">{{ stepUpLabel }}</NTag>
              </div>
              <NAlert type="info" :show-icon="false">
                高危写操作会在后端强制校验 StepUp。验证通过后 {{ status?.windowSeconds || 300 }} 秒内有效。
              </NAlert>
            </NSpace>
          </NCard>
        </NGridItem>
      </NGrid>
    </ResourceState>

    <StepUpDialog v-model:show="showStepUp" @verified="onStepUpVerified" @cancelled="onStepUpCancelled" />
  </ResourcePageShell>
</template>
