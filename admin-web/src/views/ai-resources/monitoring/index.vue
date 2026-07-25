<script setup lang="ts">
import { ref } from 'vue';
import type {
  ResourceCreate,
  ResourceDelete,
  ResourceList,
  ResourceRowAction,
  ResourceUpdate
} from '@/components/platform/resource-crud';
import { useCapability } from '@/composables/use-capability';
import {
  createAIResource,
  createScheduledTest,
  deleteAIResource,
  deleteScheduledTest,
  listAIResources,
  listScheduledTests,
  runAIResourceAction,
  updateAIResource,
  updateScheduledTest
} from '@/service/ai-resources';

defineOptions({ name: 'AIResourceMonitoringPage' });
const { can } = useCapability();
const accountId = ref<number | null>(null);
const emptyPage = { docs: [], page: 1, totalDocs: 0, totalPages: 1 };

const monitorList: ResourceList = (query, signal) => listAIResources('monitors', query, signal);
const monitorCreate: ResourceCreate = input => createAIResource('monitors', input);
const monitorUpdate: ResourceUpdate = (id, input) => updateAIResource('monitors', id, input);
const monitorDelete: ResourceDelete = id => deleteAIResource('monitors', id);
const monitorActions: ResourceRowAction[] = [
  { label: '立即检测', type: 'primary', handler: row => runAIResourceAction('runChannelMonitor', row.id) }
];

const templateList: ResourceList = (query, signal) => listAIResources('monitorTemplates', query, signal);
const templateCreate: ResourceCreate = input => createAIResource('monitorTemplates', input);
const templateUpdate: ResourceUpdate = (id, input) => updateAIResource('monitorTemplates', id, input);
const templateDelete: ResourceDelete = id => deleteAIResource('monitorTemplates', id);

const scheduledList: ResourceList = query =>
  accountId.value ? listScheduledTests(accountId.value, query) : Promise.resolve(emptyPage);
const scheduledCreate: ResourceCreate = createScheduledTest;
const scheduledUpdate: ResourceUpdate = updateScheduledTest;
const scheduledDelete: ResourceDelete = deleteScheduledTest;

const providerOptions = ['openai', 'anthropic', 'gemini', 'grok'].map(value => ({ label: value, value }));
const apiModeOptions = [
  { label: 'Chat Completions', value: 'chat_completions' },
  { label: 'Responses', value: 'responses' }
];
</script>

<template>
  <ResourcePageShell title="渠道监控" description="集中管理可用性监控、请求模板和账号定时测试">
    <NTabs type="segment" animated>
      <NTabPane name="monitors" tab="可用性监控">
        <ResourceCrudPage
          title="可用性监控"
          description="手动或定时检查渠道模型可用性"
          :can-write="can('ai-resources:write')"
          :columns="[
            { key: 'name', label: '监控名称' },
            { key: 'provider', label: '平台', options: providerOptions },
            { key: 'primary_model', label: '主模型' },
            { key: 'primary_status', label: '最近状态' },
            { key: 'primary_latency_ms', label: '延迟 ms' },
            { key: 'availability_7d', label: '7 日可用率' },
            { key: 'enabled', label: '启用', kind: 'boolean' }
          ]"
          :fields="[
            { key: 'name', label: '监控名称', required: true },
            { key: 'provider', label: '平台', type: 'select', options: providerOptions, required: true },
            { key: 'api_mode', label: 'API 模式', type: 'select', options: apiModeOptions },
            { key: 'endpoint', label: '请求地址', required: true },
            {
              key: 'api_key',
              label: '新 API Key',
              type: 'password',
              writeOnly: true,
              placeholder: '编辑留空表示不修改'
            },
            { key: 'primary_model', label: '主模型', required: true },
            { key: 'extra_models', label: '额外模型 JSON', type: 'json' },
            { key: 'group_name', label: '分组名' },
            { key: 'enabled', label: '启用', type: 'switch' },
            { key: 'interval_seconds', label: '检查间隔（秒）', type: 'number' },
            { key: 'jitter_seconds', label: '随机抖动（秒）', type: 'number' },
            { key: 'extra_headers', label: '附加请求头 JSON', type: 'json' },
            { key: 'body_override', label: '请求体覆盖 JSON', type: 'json' }
          ]"
          :defaults="{
            provider: 'openai',
            api_mode: 'chat_completions',
            enabled: true,
            interval_seconds: 300,
            jitter_seconds: 0
          }"
          :list="monitorList"
          :create="monitorCreate"
          :update="monitorUpdate"
          :remove="monitorDelete"
          :row-actions="monitorActions"
        />
      </NTabPane>

      <NTabPane name="templates" tab="请求模板">
        <ResourceCrudPage
          title="监控请求模板"
          description="复用请求头和请求体配置，不保存明文凭据"
          :can-write="can('ai-resources:write')"
          :columns="[
            { key: 'name', label: '模板名称' },
            { key: 'provider', label: '平台', options: providerOptions },
            { key: 'api_mode', label: 'API 模式', options: apiModeOptions },
            { key: 'associated_monitors', label: '关联监控' },
            { key: 'updated_at', label: '更新时间', kind: 'date' }
          ]"
          :fields="[
            { key: 'name', label: '模板名称', required: true },
            { key: 'provider', label: '平台', type: 'select', options: providerOptions, required: true },
            { key: 'api_mode', label: 'API 模式', type: 'select', options: apiModeOptions },
            { key: 'description', label: '说明', type: 'textarea' },
            { key: 'extra_headers', label: '请求头 JSON', type: 'json' },
            {
              key: 'body_override_mode',
              label: '请求体策略',
              type: 'select',
              options: [
                { label: '关闭', value: 'off' },
                { label: '合并', value: 'merge' },
                { label: '替换', value: 'replace' }
              ]
            },
            { key: 'body_override', label: '请求体 JSON', type: 'json' }
          ]"
          :defaults="{ provider: 'openai', api_mode: 'chat_completions', body_override_mode: 'off' }"
          :list="templateList"
          :create="templateCreate"
          :update="templateUpdate"
          :remove="templateDelete"
        />
      </NTabPane>

      <NTabPane name="scheduled" tab="定时测试">
        <NAlert type="info" :bordered="false" class="mb-12px">
          <div class="flex-y-center gap-12px lt-sm:flex-col lt-sm:items-stretch">
            <span>先输入要查看的上游账号 ID：</span>
            <NInputNumber v-model:value="accountId" :min="1" class="w-180px" placeholder="账号 ID" />
          </div>
        </NAlert>
        <ResourceCrudPage
          title="账号定时测试"
          description="按 Cron 计划验证账号模型并保留有限结果"
          :can-write="can('ai-resources:write')"
          :columns="[
            { key: 'account_id', label: '账号 ID' },
            { key: 'model_id', label: '模型' },
            { key: 'cron_expression', label: 'Cron' },
            { key: 'last_run_at', label: '上次执行', kind: 'date' },
            { key: 'next_run_at', label: '下次执行', kind: 'date' },
            { key: 'enabled', label: '启用', kind: 'boolean' }
          ]"
          :fields="[
            { key: 'account_id', label: '账号 ID', type: 'number', required: true },
            { key: 'model_id', label: '模型 ID', required: true },
            { key: 'cron_expression', label: 'Cron 表达式', required: true },
            { key: 'enabled', label: '启用', type: 'switch' },
            { key: 'max_results', label: '保留结果数', type: 'number' },
            { key: 'auto_recover', label: '成功后自动恢复账号', type: 'switch' }
          ]"
          :defaults="{ account_id: accountId || undefined, enabled: true, max_results: 20, auto_recover: false }"
          :list="scheduledList"
          :create="scheduledCreate"
          :update="scheduledUpdate"
          :remove="scheduledDelete"
        />
      </NTabPane>
    </NTabs>
  </ResourcePageShell>
</template>
