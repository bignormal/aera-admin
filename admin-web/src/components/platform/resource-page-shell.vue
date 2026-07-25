<script setup lang="ts">
defineOptions({ name: 'ResourcePageShell' });

defineProps<{
  description?: string;
  title: string;
}>();
</script>

<template>
  <NSpace vertical :size="16">
    <div class="flex-y-center justify-between gap-12px lt-sm:flex-col lt-sm:items-stretch">
      <div>
        <h1 class="m-0 text-24px font-600">{{ title }}</h1>
        <p v-if="description" class="mb-0 mt-6px text-14px text-gray-500">{{ description }}</p>
      </div>
      <NSpace v-if="$slots.actions" align="center">
        <slot name="actions" />
      </NSpace>
    </div>

    <NCard v-if="$slots.filters" :bordered="false" class="card-wrapper">
      <slot name="filters" />
    </NCard>

    <slot />
  </NSpace>
</template>
