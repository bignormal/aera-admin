<script setup lang="ts">
import { computed } from 'vue'
import { NAlert, NEmpty, NSpace, NTag, NText, NTimeline, NTimelineItem } from 'naive-ui'
import {
  desktopDeliveryTimeline,
  type ContentDeliveryLink,
  type DesktopDeliveryTimelineStage,
} from '@/service/publishing'

defineOptions({ name: 'ContentDeliveryTimeline' })

const props = defineProps<{ link: ContentDeliveryLink }>()
const timeline = computed(() => desktopDeliveryTimeline(props.link))

function date(value?: string) {
  if (!value) return '—'
  return new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value))
}

function tagType(stage: DesktopDeliveryTimelineStage) {
  if (stage.state === 'failed') return 'error'
  if (stage.state === 'complete') return 'success'
  return 'default'
}

function short(value?: string) {
  return value ? `${value.slice(0, 8)}…` : '—'
}
</script>

<template>
  <div class="flex flex-col gap-12px">
    <NAlert
      :type="timeline.delivered ? 'success' : timeline.summary === 'Desktop 验证失败' ? 'error' : 'info'"
      :show-icon="false"
    >
      {{ timeline.summary }}
    </NAlert>

    <NEmpty v-if="timeline.stages.length === 0" description="尚未发布到 Cloud" />
    <NTimeline v-else>
      <NTimelineItem
        v-for="item in timeline.stages"
        :key="item.key"
        :type="tagType(item)"
        :title="item.label"
      >
        <template #default>
          <NSpace v-if="item.stage" size="small" wrap>
            <NTag size="small" :bordered="false">{{ item.stage.deviceCount }} 台设备</NTag>
            <NTag v-if="item.stage.desktopVersion" size="small" :bordered="false">
              Desktop {{ item.stage.desktopVersion }}
            </NTag>
            <NTag v-if="item.stage.runtimeVersion" size="small" :bordered="false">
              Runtime {{ item.stage.runtimeVersion }}
            </NTag>
            <NText v-if="item.stage.contentDigest" depth="3">
              摘要 {{ short(item.stage.contentDigest) }}
            </NText>
            <NText v-if="item.stage.requestId" depth="3">
              请求 ID {{ item.stage.requestId }}
            </NText>
            <NText v-if="item.stage.errorCode" type="error">
              {{ item.stage.errorCode }}
            </NText>
            <NText v-if="item.stage.occurredAt" depth="3">{{ date(item.stage.occurredAt) }}</NText>
          </NSpace>
          <NText v-else depth="3">等待 Desktop 回执</NText>
        </template>
      </NTimelineItem>
    </NTimeline>
  </div>
</template>
