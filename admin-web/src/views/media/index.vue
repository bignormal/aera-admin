<script setup lang="ts">
import { computed, h, onMounted, reactive, ref } from 'vue';
import type { DataTableColumns } from 'naive-ui';
import { NButton, NImage, NSpace } from 'naive-ui';
import { useCapability } from '@/composables/use-capability';
import { ApiError } from '@/service/http';
import { deleteMedia, listMedia, uploadMedia, type MediaRecord } from '@/service/media';

defineOptions({ name: 'MediaPage' });

const { can } = useCapability();
const loading = ref(false);
const saving = ref(false);
const state = ref<'empty' | 'error' | 'loading' | 'ready' | 'unavailable'>('loading');
const rows = ref<MediaRecord[]>([]);
const total = ref(0);
const query = reactive({ page: 1, limit: 10, search: '', sort: '-updatedAt' });
const showUpload = ref(false);
const selectedFile = ref<File>();
const metadata = reactive({ alt: '', attribution: '' });

const pagination = computed(() => ({
  page: query.page,
  pageSize: query.limit,
  itemCount: total.value,
  onChange(page: number) {
    query.page = page;
    void load();
  }
}));

const columns: DataTableColumns<MediaRecord> = [
  {
    title: '预览',
    key: 'preview',
    width: 90,
    render: row => (row.url ? h(NImage, { src: row.url, width: 48, height: 48, objectFit: 'cover' }) : '—')
  },
  { title: '图片说明', key: 'alt' },
  { title: '文件名', key: 'filename' },
  { title: '类型', key: 'mimeType' },
  { title: '来源', key: 'attribution', render: row => row.attribution || '—' },
  {
    title: '操作',
    key: 'actions',
    width: 90,
    render: row =>
      can('content:media:write')
        ? h(NSpace, () => [h(NButton, { text: true, type: 'error', onClick: () => confirmDelete(row) }, () => '删除')])
        : '—'
  }
];

async function load() {
  loading.value = true;
  if (!rows.value.length) state.value = 'loading';
  try {
    const result = await listMedia(query);
    rows.value = result.docs;
    total.value = result.totalDocs;
    state.value = result.docs.length ? 'ready' : 'empty';
  } catch (error) {
    state.value = error instanceof ApiError && error.status === 0 ? 'unavailable' : 'error';
  } finally {
    loading.value = false;
  }
}

function chooseFile(event: Event) {
  selectedFile.value = (event.target as HTMLInputElement).files?.[0];
}

async function submitUpload() {
  if (!selectedFile.value || !metadata.alt.trim()) {
    window.$message?.warning('请选择图片并填写图片说明');
    return;
  }
  saving.value = true;
  try {
    await uploadMedia(selectedFile.value, { ...metadata });
    showUpload.value = false;
    selectedFile.value = undefined;
    Object.assign(metadata, { alt: '', attribution: '' });
    await load();
  } catch (error) {
    if (error instanceof ApiError) window.$message?.error(error.message);
  } finally {
    saving.value = false;
  }
}

function confirmDelete(row: MediaRecord) {
  window.$dialog?.warning({
    title: '删除媒体',
    content: `确认删除“${row.alt}”吗？被内容引用的媒体无法删除。`,
    positiveText: '删除',
    negativeText: '取消',
    async onPositiveClick() {
      await deleteMedia(row.id);
      await load();
    }
  });
}

onMounted(load);
</script>

<template>
  <ResourcePageShell title="媒体资源" description="统一管理智能体头像、宠物图集和预览图">
    <template #actions>
      <NButton v-if="can('content:media:write')" type="primary" @click="showUpload = true">上传媒体</NButton>
    </template>
    <template #filters>
      <div class="flex gap-8px lt-sm:flex-col">
        <NInput v-model:value="query.search" clearable placeholder="搜索图片说明" @keyup.enter="load" />
        <NButton :loading="loading" @click="load">搜索</NButton>
      </div>
    </template>
    <NCard :bordered="false" class="card-wrapper">
      <ResourceState :state="state">
        <template #actions><NButton @click="load">重试</NButton></template>
        <div class="max-w-full overflow-x-auto">
          <NDataTable
            remote
            :columns="columns"
            :data="rows"
            :loading="loading"
            :pagination="pagination"
            :row-key="row => row.id"
            :scroll-x="760"
          />
        </div>
      </ResourceState>
    </NCard>

    <NModal v-model:show="showUpload" preset="card" title="上传媒体" class="w-520px max-w-[calc(100vw-32px)]">
      <NForm label-placement="top">
        <NFormItem label="图片文件" required>
          <input type="file" accept="image/jpeg,image/png,image/webp" @change="chooseFile" />
        </NFormItem>
        <NFormItem label="图片说明" required><NInput v-model:value="metadata.alt" /></NFormItem>
        <NFormItem label="来源说明"><NInput v-model:value="metadata.attribution" /></NFormItem>
      </NForm>
      <template #footer>
        <NSpace justify="end">
          <NButton @click="showUpload = false">取消</NButton>
          <NButton type="primary" :loading="saving" @click="submitUpload">上传</NButton>
        </NSpace>
      </template>
    </NModal>
  </ResourcePageShell>
</template>
