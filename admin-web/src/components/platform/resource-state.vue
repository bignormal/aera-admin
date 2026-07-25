<script setup lang="ts">
import { computed } from 'vue';

defineOptions({ name: 'ResourceState' });

type ResourceState = 'empty' | 'error' | 'forbidden' | 'loading' | 'ready' | 'unavailable';

const props = withDefaults(
  defineProps<{
    description?: string;
    state: ResourceState;
    title?: string;
  }>(),
  {
    description: '',
    title: ''
  }
);

const result = computed(() => {
  switch (props.state) {
    case 'forbidden':
      return {
        description: props.description || '当前角色无权访问此资源。',
        status: '403' as const,
        title: props.title || '无权访问'
      };
    case 'unavailable':
      return {
        description: props.description || '后端服务暂时不可用，请稍后重试。',
        status: '500' as const,
        title: props.title || '服务不可用'
      };
    default:
      return {
        description: props.description || '加载资源时发生错误，请稍后重试。',
        status: 'error' as const,
        title: props.title || '加载失败'
      };
  }
});
</script>

<template>
  <div v-if="state === 'loading'" class="flex min-h-240px items-center justify-center">
    <NSpin size="large" description="正在加载" />
  </div>
  <NEmpty v-else-if="state === 'empty'" :description="description || '暂无数据'">
    <template v-if="$slots.actions" #extra><slot name="actions" /></template>
  </NEmpty>
  <slot v-else-if="state === 'ready'" />
  <NResult v-else :status="result.status" :title="result.title" :description="result.description">
    <template v-if="$slots.actions" #footer><slot name="actions" /></template>
  </NResult>
</template>
