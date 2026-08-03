<script setup lang="ts">
import { computed, h, onMounted, ref } from 'vue';
import type { DataTableColumns } from 'naive-ui';
import { NButton, NSpace, NTag } from 'naive-ui';
import OfficialAgentsPanel from './modules/official-agents-panel.vue';
import { useCapability } from '@/composables/use-capability';
import { getPublishingSurfaceAccess } from '@/constants/capabilities';
import { listAgents } from '@/service/agents';
import { ApiError } from '@/service/http';
import { listPets } from '@/service/pets';
import { listPlugins } from '@/service/plugins';
import { publishResource, saveResourceDraft, type PublishingCollection } from '@/service/publishing';
import type { ResourceID } from '@/service/resources';
import { listSkills } from '@/service/skills';
import { useAuthStore } from '@/store/modules/auth';

defineOptions({ name: 'PublishingPage' });

type PublishingRow = {
  collection: PublishingCollection;
  id: ResourceID;
  name: string;
  status: 'draft' | 'published';
  type: string;
  updatedAt: string;
  version: string;
};

const { can } = useCapability();
const authStore = useAuthStore();
const surfaceAccess = computed(() => getPublishingSurfaceAccess(authStore.userInfo.role));
const activeTab = ref<'catalog' | 'official'>(surfaceAccess.value.catalog ? 'catalog' : 'official');
const loading = ref(false);
const state = ref<'empty' | 'error' | 'loading' | 'ready' | 'unavailable'>('loading');
const rows = ref<PublishingRow[]>([]);

const columns: DataTableColumns<PublishingRow> = [
  { title: '类型', key: 'type' },
  { title: '名称', key: 'name' },
  { title: '版本', key: 'version' },
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
      can('content:publish:execute')
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
    rows.value = [
      ...agents.docs.map(item => ({
        collection: 'agent-templates' as const,
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
        version: item.version
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

onMounted(() => {
  if (surfaceAccess.value.catalog) void load();
});
</script>

<template>
  <ResourcePageShell title="发布中心" description="本地目录发布与 aera-cloud 官方 Agent 审核发布统一入口">
    <template #actions>
      <NButton v-if="surfaceAccess.catalog && activeTab === 'catalog'" :loading="loading" @click="load">刷新</NButton>
    </template>
    <NTabs v-model:value="activeTab" type="line" animated>
      <NTabPane v-if="surfaceAccess.catalog" name="catalog" tab="目录发布">
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
      <NTabPane v-if="surfaceAccess.official" name="official" tab="官方 Agent 工作台">
        <NCard :bordered="false" class="card-wrapper">
          <OfficialAgentsPanel />
        </NCard>
      </NTabPane>
    </NTabs>
  </ResourcePageShell>
</template>
