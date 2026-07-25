<script setup lang="ts">
import { onMounted, ref } from 'vue';
import type {
  ResourceCreate,
  ResourceDelete,
  ResourceList,
  ResourceRowAction,
  ResourceUpdate
} from '@/components/platform/resource-crud';
import { useCapability } from '@/composables/use-capability';
import { useStepUp } from '@/composables/use-step-up';
import {
  createBackup,
  deleteBackup,
  getBackupDownloadURL,
  getBackupSchedule,
  listOperationalResources,
  restoreBackup,
  updateBackupSchedule
} from '@/service/operations';

defineOptions({ name: 'SystemDataPage' });

const { can } = useCapability();
const { onStepUpCancelled, onStepUpVerified, runProtected, showStepUp } = useStepUp();
const schedule = ref('{}');
const scheduleLoading = ref(false);
const backups: ResourceList = (query, signal) => listOperationalResources('backups', query, signal);
const create: ResourceCreate = input => createBackup(input);
const update: ResourceUpdate = async () => undefined;
const remove: ResourceDelete = id => deleteBackup(id);
const downloadActions: ResourceRowAction[] = [
  {
    label: '下载',
    type: 'primary',
    async handler(row) {
      const result = await getBackupDownloadURL(row.id);
      const source = result && typeof result === 'object' ? (result as Record<string, unknown>) : {};
      const url = typeof result === 'string' ? result : typeof source.url === 'string' ? source.url : '';
      if (!url) throw new Error('上游未返回下载地址');
      window.open(url, '_blank', 'noopener,noreferrer');
    }
  },
  {
    label: '恢复',
    type: 'error',
    async handler(row) {
      const reason = window.prompt('请输入恢复原因', '管理员恢复备份');
      if (reason === null) return;
      await runProtected(() => restoreBackup(row.id, { reason }));
    }
  }
];

async function loadSchedule() {
  scheduleLoading.value = true;
  try {
    schedule.value = JSON.stringify(await getBackupSchedule(), null, 2);
  } catch {
    schedule.value = '{}';
  } finally {
    scheduleLoading.value = false;
  }
}

async function saveSchedule() {
  try {
    await updateBackupSchedule(JSON.parse(schedule.value) as Record<string, unknown>);
    window.$message?.success('备份计划已更新');
    await loadSchedule();
  } catch (error) {
    window.$message?.error(error instanceof SyntaxError ? '备份计划必须是合法 JSON' : '备份计划更新失败');
  }
}

onMounted(loadSchedule);
</script>

<template>
  <ResourcePageShell
    title="数据与备份"
    description="管理 AgentEra API 的备份任务、备份计划和高危恢复操作"
  >
    <NCard :bordered="false" class="card-wrapper mb-16px" title="备份计划">
      <NInput v-model:value="schedule" type="textarea" :rows="8" />
      <NSpace class="mt-12px">
        <NButton :loading="scheduleLoading" @click="loadSchedule">刷新计划</NButton>
        <NButton v-if="can('system:write')" type="primary" @click="saveSchedule">保存计划</NButton>
      </NSpace>
    </NCard>

    <ResourceCrudPage
      title="平台备份"
      :can-write="can('system:write')"
      hide-edit
      :columns="[
        { key: 'name', label: '备份名称' },
        { key: 'type', label: '类型' },
        { key: 'status', label: '状态' },
        { key: 'size', label: '大小' },
        { key: 'created_at', label: '创建时间', kind: 'date' }
      ]"
      :fields="[
        { key: 'name', label: '备份名称', required: true },
        { key: 'description', label: '说明', type: 'textarea' },
        { key: 'type', label: '备份类型', required: true }
      ]"
      :defaults="{ type: 'full' }"
      :list="backups"
      :create="create"
      :update="update"
      :remove="remove"
      :row-actions="downloadActions"
    />
    <StepUpDialog v-model:show="showStepUp" @verified="onStepUpVerified" @cancelled="onStepUpCancelled" />
  </ResourcePageShell>
</template>
