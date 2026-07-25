<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useCapability } from '@/composables/use-capability';
import { useStepUp } from '@/composables/use-step-up';
import {
  checkSystemUpdates,
  deleteAdminAPIKey,
  getOperationalSnapshot,
  performSystemUpdate,
  regenerateAdminAPIKey,
  restartSystem,
  rollbackSystem,
  updateSystemSettings
} from '@/service/operations';

defineOptions({ name: 'SystemSettingsPage' });

const { can } = useCapability();
const { onStepUpCancelled, onStepUpVerified, runProtected, showStepUp } = useStepUp();
const loading = ref(false);
const saving = ref(false);
const state = ref<'error' | 'loading' | 'ready' | 'unavailable'>('loading');
const settings = ref('{}');
const version = ref<Record<string, unknown>>({});
const keyStatus = ref<Record<string, unknown>>({});

async function load() {
  loading.value = true;
  state.value = 'loading';
  try {
    const [nextSettings, nextVersion, nextKeyStatus] = await Promise.all([
      getOperationalSnapshot('getSystemSettings'),
      getOperationalSnapshot('getSystemVersion'),
      getOperationalSnapshot('getAdminAPIKeyStatus')
    ]);
    settings.value = JSON.stringify(nextSettings, null, 2);
    version.value = nextVersion;
    keyStatus.value = nextKeyStatus;
    state.value = 'ready';
  } catch {
    state.value = 'unavailable';
  } finally {
    loading.value = false;
  }
}

async function save() {
  try {
    const value = JSON.parse(settings.value) as Record<string, unknown>;
    saving.value = true;
    await updateSystemSettings(value);
    window.$message?.success('系统设置已更新');
  } catch (error) {
    window.$message?.error(error instanceof SyntaxError ? '设置必须是合法 JSON' : '更新失败');
  } finally {
    saving.value = false;
  }
}

async function runSystemAction(label: string, action: () => Promise<unknown>) {
  try {
    const result = await runProtected(action);
    window.$dialog?.success({ title: `${label}已提交`, content: JSON.stringify(result, null, 2), positiveText: '关闭' });
    await load();
  } catch {
    window.$message?.error(`${label}失败或已取消。`);
  }
}

async function checkUpdates() {
  try {
    version.value = { ...version.value, updates: await checkSystemUpdates() };
    window.$message?.success('更新检查完成');
  } catch {
    window.$message?.error('检查更新失败');
  }
}

onMounted(load);
</script>

<template>
  <ResourcePageShell title="系统设置" description="查看版本、API 管理密钥状态并维护普通系统配置">
    <template #actions><NButton :loading="loading" @click="load">刷新</NButton></template>
    <ResourceState :state="state">
      <template #actions><NButton @click="load">重试</NButton></template>
      <NGrid cols="1 l:3" responsive="screen" :x-gap="16" :y-gap="16">
        <NGridItem span="1 l:2">
          <NCard title="系统配置" :bordered="false" class="card-wrapper">
            <NInput v-model:value="settings" type="textarea" :rows="20" />
            <NButton
              v-if="can('system:write')"
              class="mt-12px"
              type="primary"
              :loading="saving"
              @click="save"
            >
              保存设置
            </NButton>
          </NCard>
        </NGridItem>
        <NGridItem>
          <NSpace vertical :size="16">
            <NCard title="系统版本" :bordered="false" class="card-wrapper">
              <NCode :code="JSON.stringify(version, null, 2)" language="json" word-wrap />
              <NSpace v-if="can('system:write')" class="mt-12px" wrap>
                <NButton @click="checkUpdates">检查更新</NButton>
                <NButton type="primary" @click="runSystemAction('系统更新', () => performSystemUpdate())">执行更新</NButton>
                <NButton type="warning" @click="runSystemAction('系统回滚', () => rollbackSystem())">回滚</NButton>
                <NButton type="error" @click="runSystemAction('系统重启', () => restartSystem())">重启</NButton>
              </NSpace>
            </NCard>
            <NCard title="管理密钥状态" :bordered="false" class="card-wrapper">
              <NCode :code="JSON.stringify(keyStatus, null, 2)" language="json" word-wrap />
              <NSpace v-if="can('system:write')" class="mt-12px" wrap>
                <NButton type="warning" @click="runSystemAction('重新生成 Admin Key', () => regenerateAdminAPIKey())">
                  重新生成
                </NButton>
                <NButton type="error" @click="runSystemAction('删除 Admin Key', () => deleteAdminAPIKey())">删除</NButton>
              </NSpace>
            </NCard>
          </NSpace>
        </NGridItem>
      </NGrid>
      <NAlert class="mt-16px" type="warning">
        系统更新、回滚、重启和 Admin Key 变更属于高风险操作，会要求 TOTP StepUp。
      </NAlert>
    </ResourceState>
    <StepUpDialog v-model:show="showStepUp" @verified="onStepUpVerified" @cancelled="onStepUpCancelled" />
  </ResourcePageShell>
</template>
