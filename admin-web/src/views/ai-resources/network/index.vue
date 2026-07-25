<script setup lang="ts">
import type { ResourceCreate, ResourceDelete, ResourceList, ResourceUpdate } from '@/components/platform/resource-crud';
import { useCapability } from '@/composables/use-capability';
import { createAIResource, deleteAIResource, listAIResources, updateAIResource } from '@/service/ai-resources';

defineOptions({ name: 'AIResourceNetworkPage' });
const { can } = useCapability();

const tlsList: ResourceList = (query, signal) => listAIResources('tlsProfiles', query, signal);
const tlsCreate: ResourceCreate = input => createAIResource('tlsProfiles', input);
const tlsUpdate: ResourceUpdate = (id, input) => updateAIResource('tlsProfiles', id, input);
const tlsDelete: ResourceDelete = id => deleteAIResource('tlsProfiles', id);

const ruleList: ResourceList = (query, signal) => listAIResources('errorRules', query, signal);
const ruleCreate: ResourceCreate = input => createAIResource('errorRules', input);
const ruleUpdate: ResourceUpdate = (id, input) => updateAIResource('errorRules', id, input);
const ruleDelete: ResourceDelete = id => deleteAIResource('errorRules', id);
</script>

<template>
  <ResourcePageShell title="高级网络" description="管理 TLS 指纹和上游错误透传策略">
    <NTabs type="segment" animated>
      <NTabPane name="tls" tab="TLS 指纹">
        <ResourceCrudPage
          title="TLS 指纹配置"
          description="为需要浏览器指纹兼容的上游账号提供可复用配置"
          :can-write="can('ai-resources:write')"
          :columns="[
            { key: 'name', label: '配置名称' },
            { key: 'description', label: '说明' },
            { key: 'enable_grease', label: 'GREASE', kind: 'boolean' },
            { key: 'alpn_protocols', label: 'ALPN' },
            { key: 'updated_at', label: '更新时间', kind: 'date' }
          ]"
          :fields="[
            { key: 'name', label: '配置名称', required: true },
            { key: 'description', label: '说明', type: 'textarea' },
            { key: 'enable_grease', label: '启用 GREASE', type: 'switch' },
            { key: 'cipher_suites', label: 'Cipher Suites JSON', type: 'json' },
            { key: 'curves', label: 'Curves JSON', type: 'json' },
            { key: 'signature_algorithms', label: '签名算法 JSON', type: 'json' },
            { key: 'alpn_protocols', label: 'ALPN JSON', type: 'json' },
            { key: 'supported_versions', label: 'TLS 版本 JSON', type: 'json' },
            { key: 'extensions', label: 'Extensions JSON', type: 'json' }
          ]"
          :defaults="{ enable_grease: true }"
          :list="tlsList"
          :create="tlsCreate"
          :update="tlsUpdate"
          :remove="tlsDelete"
        />
      </NTabPane>

      <NTabPane name="errors" tab="错误透传">
        <ResourceCrudPage
          title="错误透传规则"
          description="按优先级匹配上游错误，并控制响应码、消息和监控行为"
          :can-write="can('ai-resources:write')"
          :columns="[
            { key: 'name', label: '规则名称' },
            { key: 'priority', label: '优先级' },
            {
              key: 'match_mode',
              label: '匹配模式',
              options: [
                { label: '任一', value: 'any' },
                { label: '全部', value: 'all' }
              ]
            },
            { key: 'response_code', label: '响应码' },
            { key: 'enabled', label: '启用', kind: 'boolean' }
          ]"
          :fields="[
            { key: 'name', label: '规则名称', required: true },
            { key: 'description', label: '说明', type: 'textarea' },
            { key: 'enabled', label: '启用', type: 'switch' },
            { key: 'priority', label: '优先级', type: 'number' },
            {
              key: 'match_mode',
              label: '匹配模式',
              type: 'select',
              options: [
                { label: '任一', value: 'any' },
                { label: '全部', value: 'all' }
              ]
            },
            { key: 'error_codes', label: '错误码 JSON', type: 'json' },
            { key: 'keywords', label: '关键词 JSON', type: 'json' },
            { key: 'platforms', label: '平台 JSON', type: 'json' },
            { key: 'passthrough_code', label: '透传响应码', type: 'switch' },
            { key: 'response_code', label: '自定义响应码', type: 'number' },
            { key: 'passthrough_body', label: '透传响应体', type: 'switch' },
            { key: 'custom_message', label: '自定义消息', type: 'textarea' },
            { key: 'skip_monitoring', label: '跳过异常监控', type: 'switch' }
          ]"
          :defaults="{
            enabled: true,
            priority: 0,
            match_mode: 'any',
            passthrough_code: true,
            passthrough_body: true,
            skip_monitoring: false
          }"
          :list="ruleList"
          :create="ruleCreate"
          :update="ruleUpdate"
          :remove="ruleDelete"
        />
      </NTabPane>
    </NTabs>
  </ResourcePageShell>
</template>
