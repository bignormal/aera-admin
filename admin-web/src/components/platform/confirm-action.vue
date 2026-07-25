<script setup lang="ts">
import { useAttrs } from 'vue';
import type { ButtonProps } from 'naive-ui';

defineOptions({ name: 'ConfirmAction', inheritAttrs: false });

const props = withDefaults(
  defineProps<{
    content: string;
    disabled?: boolean;
    loading?: boolean;
    negativeText?: string;
    positiveText?: string;
    title: string;
    type?: ButtonProps['type'];
  }>(),
  {
    disabled: false,
    loading: false,
    negativeText: '取消',
    positiveText: '确认',
    type: 'error'
  }
);

const emit = defineEmits<{ confirm: [] }>();
const attrs = useAttrs();

function openConfirm() {
  window.$dialog?.warning({
    title: props.title,
    content: props.content,
    positiveText: props.positiveText,
    negativeText: props.negativeText,
    onPositiveClick: () => emit('confirm')
  });
}
</script>

<template>
  <NButton v-bind="attrs" :disabled="disabled" :loading="loading" :type="type" @click="openConfirm">
    <slot />
  </NButton>
</template>
