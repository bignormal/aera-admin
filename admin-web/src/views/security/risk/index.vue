<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import type { ResourceCreate, ResourceDelete, ResourceList, ResourceUpdate } from '@/components/platform/resource-crud';
import { useCapability } from '@/composables/use-capability';
import {
  getOperationalSnapshot,
  listOperationalResources,
  unbanRiskUser,
  updateRiskConfig
} from '@/service/operations';

defineOptions({ name: 'SecurityRiskPage' });

const { can } = useCapability();
const loading = ref(false);
const saving = ref(false);
const unbanning = ref(false);
const state = ref<'error' | 'loading' | 'ready' | 'unavailable'>('loading');
const status = ref<Record<string, unknown>>({});
const configText = ref('{}');
const userId = ref('');
const metrics = computed(() => Object.entries(status.value));
const logs: ResourceList = (query, signal) => listOperationalResources('riskLogs', query, signal);
const noopCreate: ResourceCreate = async () => undefined;
const noopUpdate: ResourceUpdate = async () => undefined;
const noopDelete: ResourceDelete = async () => undefined;

async function load() {
  loading.value = true;
  state.value = 'loading';
  try {
    const [nextStatus, config] = await Promise.all([
      getOperationalSnapshot('getRiskStatus'),
      getOperationalSnapshot('getRiskConfig')
    ]);
    status.value = nextStatus;
    configText.value = JSON.stringify(config, null, 2);
    state.value = 'ready';
  } catch {
    state.value = 'unavailable';
  } finally {
    loading.value = false;
  }
}

async function saveConfig() {
  try {
    const value = JSON.parse(configText.value) as Record<string, unknown>;
    saving.value = true;
    await updateRiskConfig(value);
    window.$message?.success('风控配置已更新');
  } catch (error) {
    window.$message?.error(error instanceof SyntaxError ? '配置必须是合法 JSON' : '更新失败');
  } finally {
    saving.value = false;
  }
}

async function unban() {
  if (!userId.value.trim()) return;
  unbanning.value = true;
  try {
    await unbanRiskUser(userId.value.trim());
    window.$message?.success('已解除用户限制');
    userId.value = '';
  } catch {
    window.$message?.error('解除限制失败');
  } finally {
    unbanning.value = false;
  }
}

onMounted(load);
</script>

<template>
  <ResourcePageShell title="风控中心" description="查看风控状态、调整普通规则并解除用户限制；危险哈希清理入口不在后台暴露">
    <template #actions><NButton :loading="loading" @click="load">刷新</NButton></template>
    <ResourceState :state="state">
      <template #actions><NButton @click="load">重试</NButton></template>
      <NGrid cols="1 s:2 l:4" responsive="screen" :x-gap="16" :y-gap="16">
        <NGridItem v-for="[key, value] in metrics" :key="key">
          <NCard :bordered="false" class="card-wrapper">
            <NStatistic :label="key" :value="typeof value === 'object' ? JSON.stringify(value) : String(value)" />
          </NCard>
        </NGridItem>
      </NGrid>
      <NGrid class="mt-16px" cols="1 l:2" responsive="screen" :x-gap="16" :y-gap="16">
        <NGridItem>
          <NCard title="风控配置" :bordered="false" class="card-wrapper">
            <NInput v-model:value="configText" type="textarea" :rows="16" />
            <NButton
              v-if="can('operations:write')"
              class="mt-12px"
              type="primary"
              :loading="saving"
              @click="saveConfig"
            >
              保存配置
            </NButton>
          </NCard>
        </NGridItem>
        <NGridItem>
          <NCard title="解除用户限制" :bordered="false" class="card-wrapper">
            <NSpace vertical>
              <NInput v-model:value="userId" placeholder="输入用户 ID" />
              <NButton
                v-if="can('operations:write')"
                type="warning"
                :loading="unbanning"
                @click="unban"
              >
                解除限制
              </NButton>
            </NSpace>
          </NCard>
        </NGridItem>
      </NGrid>
    </ResourceState>

    <ResourceCrudPage
      title="风控日志"
      hide-create
      hide-edit
      hide-delete
      :columns="[
        { key: 'user_id', label: '用户 ID' },
        { key: 'rule', label: '规则' },
        { key: 'action', label: '动作' },
        { key: 'reason', label: '原因' },
        { key: 'created_at', label: '时间', kind: 'date' }
      ]"
      :fields="[]"
      :list="logs"
      :create="noopCreate"
      :update="noopUpdate"
      :remove="noopDelete"
    />
  </ResourcePageShell>
</template>
