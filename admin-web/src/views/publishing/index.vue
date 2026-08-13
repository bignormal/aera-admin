<script setup lang="ts">
import { computed, h, onMounted, ref } from 'vue';
import type { DataTableColumns } from 'naive-ui';
import { NButton, NSpace, NTag } from 'naive-ui';
import ContentDeliveryTimeline from './modules/content-delivery-timeline.vue';
import OfficialAgentsPanel from './modules/official-agents-panel.vue';
import { useCapability } from '@/composables/use-capability';
import { listAgents } from '@/service/agents';
import { ApiError } from '@/service/http';
import { listPets } from '@/service/pets';
import { listPlugins } from '@/service/plugins';
import {
  desktopDeliveryTimeline,
  getContentDeliveryStatus,
  publishResource,
  saveResourceDraft,
  type ContentDeliveryLink,
  type PublishingCollection
} from '@/service/publishing';
import type { ResourceID } from '@/service/resources';
import { listSkills } from '@/service/skills';

defineOptions({ name: 'PublishingPage' });

type PublishingRow = {
  collection: PublishingCollection;
  id: ResourceID;
  name: string;
  status: 'draft' | 'published';
  type: string;
  updatedAt: string;
  version: string;
  deliveryStatus?: 'cloud_published' | 'contract_pending' | 'desktop_verified' | 'registered';
  delivery?: ContentDeliveryLink;
  deliveryUnavailable?: boolean;
};

const { can } = useCapability();
const canOfficialRead = computed(() => can('official-agents:read'));
const loading = ref(false);
const state = ref<'empty' | 'error' | 'loading' | 'ready' | 'unavailable'>('loading');
const rows = ref<PublishingRow[]>([]);
const showDelivery = ref(false);
const deliveryTarget = ref<PublishingRow>();

function agentDeliveryLabel(row: PublishingRow) {
  if (row.deliveryUnavailable) return 'Cloud 状态不可用';
  if (!row.delivery) return '未同步 Cloud';
  if (row.delivery.cloudReleaseId) return desktopDeliveryTimeline(row.delivery).summary;
  const labels: Record<ContentDeliveryLink['syncStatus'], string> = {
    approved: 'Cloud 已审核',
    desktop_verified: 'Desktop 已激活',
    draft_synced: 'Cloud 草稿',
    failed: '交付失败',
    local_only: '仅后台草稿',
    released: '已发布，等待 Desktop 验证',
    submitted: '等待 Cloud 审核',
    validation_failed: 'Cloud 校验失败'
  };
  return labels[row.delivery.syncStatus];
}

function openDelivery(row: PublishingRow) {
  deliveryTarget.value = row;
  showDelivery.value = true;
}

const columns: DataTableColumns<PublishingRow> = [
  { title: '类型', key: 'type' },
  { title: '名称', key: 'name' },
  { title: '版本', key: 'version' },
  {
    title: 'Desktop 交付',
    key: 'deliveryStatus',
    render: row =>
      row.type === '智能体'
        ? h(
            NButton,
            { text: true, type: row.delivery?.syncStatus === 'desktop_verified' ? 'success' : 'primary', onClick: () => openDelivery(row) },
            () => agentDeliveryLabel(row)
          )
        : row.type !== '插件'
          ? '—'
        : h(
            NTag,
            { bordered: false, type: row.deliveryStatus === 'desktop_verified' ? 'success' : 'warning' },
            () =>
              row.deliveryStatus === 'desktop_verified'
                ? 'Desktop 已验证'
                : row.deliveryStatus === 'contract_pending'
                  ? '等待插件消费协议'
                  : '仅后台登记'
          )
  },
  {
    title: '状态',
    key: 'status',
    render: row =>
      h(NTag, { bordered: false, type: row.status === 'published' ? 'success' : 'warning' }, () =>
        row.status === 'published' ? '已发布' : '草稿'
      )
  },
  {
    title: '更新时间',
    key: 'updatedAt',
    render: row =>
      new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(row.updatedAt))
  },
  {
    title: '操作',
    key: 'actions',
    render: row =>
      row.type === '智能体'
        ? '请在官方智能体页面操作'
        : can('content:publish:execute')
        ? h(NSpace, () => [
            row.status === 'published'
              ? h(NButton, { text: true, type: 'warning', onClick: () => changeStatus(row, false) }, () => '转为草稿')
              : h(NButton, { text: true, type: 'success', onClick: () => changeStatus(row, true) }, () => '发布')
          ])
        : '只读'
  }
];

async function load() {
  loading.value = true;
  state.value = 'loading';
  try {
    const query = { page: 1, limit: 100, search: '', sort: '-updatedAt' };
    const [agents, skills, plugins, pets] = await Promise.all([
      listAgents(query),
      listSkills(query),
      listPlugins(query),
      listPets(query)
    ]);
    const agentDeliveries = await Promise.all(
      agents.docs.map(async item => {
        try {
          return { delivery: await getContentDeliveryStatus('agent', item.id), unavailable: false };
        } catch (error) {
          return { delivery: undefined, unavailable: !(error instanceof ApiError && error.status === 404) };
        }
      })
    );
    rows.value = [
      ...agents.docs.map((item, index) => ({
        collection: 'agent-templates' as const,
        delivery: agentDeliveries[index]?.delivery,
        deliveryUnavailable: agentDeliveries[index]?.unavailable,
        id: item.id,
        name: item.name,
        status: item['_status'] === 'published' ? ('published' as const) : ('draft' as const),
        type: '智能体',
        updatedAt: item.updatedAt,
        version: String(item.releaseVersion || 0)
      })),
      ...skills.docs.map(item => ({
        collection: 'skill-catalog' as const,
        id: item.id,
        name: item.name,
        status: item['_status'] === 'published' ? ('published' as const) : ('draft' as const),
        type: '技能',
        updatedAt: item.updatedAt,
        version: item.minimumRuntimeVersion || '—'
      })),
      ...plugins.docs.map(item => ({
        collection: 'plugin-catalog' as const,
        id: item.id,
        name: item.name,
        status: item['_status'] === 'published' ? ('published' as const) : ('draft' as const),
        type: '插件',
        updatedAt: item.updatedAt,
        version: item.version,
        deliveryStatus: item.deliveryStatus
      })),
      ...pets.docs.map(item => ({
        collection: 'pet-assets' as const,
        id: item.id,
        name: item.name,
        status: item['_status'] === 'published' ? ('published' as const) : ('draft' as const),
        type: '宠物',
        updatedAt: item.updatedAt,
        version: item.version
      }))
    ];
    state.value = rows.value.length ? 'ready' : 'empty';
  } catch (error) {
    state.value = error instanceof ApiError && error.status === 0 ? 'unavailable' : 'error';
  } finally {
    loading.value = false;
  }
}

async function changeStatus(row: PublishingRow, published: boolean) {
  try {
    if (published) await publishResource(row.collection, row.id);
    else await saveResourceDraft(row.collection, row.id);
    await load();
  } catch (error) {
    if (error instanceof ApiError) window.$message?.error(error.message);
  }
}

onMounted(load);
</script>

<template>
  <div>
    <ResourcePageShell title="发布中心" description="本地目录发布与 aera-cloud 官方 Agent 审核发布统一入口">
      <template #actions><NButton :loading="loading" @click="load">刷新</NButton></template>
      <NTabs type="line" animated>
        <NTabPane name="catalog" tab="目录发布">
          <NCard :bordered="false" class="card-wrapper">
            <ResourceState :state="state">
              <template #actions><NButton @click="load">重试</NButton></template>
              <div class="max-w-full overflow-x-auto">
                <NDataTable
                  :columns="columns"
                  :data="rows"
                  :loading="loading"
                  :row-key="row => `${row.collection}:${row.id}`"
                  :scroll-x="820"
                />
              </div>
            </ResourceState>
          </NCard>
        </NTabPane>
        <NTabPane v-if="canOfficialRead" name="official" tab="官方 Agent 工作台">
          <NCard :bordered="false" class="card-wrapper">
            <OfficialAgentsPanel />
          </NCard>
        </NTabPane>
      </NTabs>
    </ResourcePageShell>

    <NModal
      v-model:show="showDelivery"
      preset="card"
      :title="`${deliveryTarget?.name || '官方智能体'} · Desktop 交付验证`"
      class="w-760px max-w-[calc(100vw-32px)]"
    >
      <ContentDeliveryTimeline v-if="deliveryTarget?.delivery" :link="deliveryTarget.delivery" />
      <NAlert v-else-if="deliveryTarget?.deliveryUnavailable" type="error" :show-icon="false">
        Cloud 交付状态暂时不可用，请稍后重试。
      </NAlert>
      <NEmpty v-else description="该官方智能体尚未同步 Cloud" />
    </NModal>
  </div>
</template>
