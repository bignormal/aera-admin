<script setup lang="ts">
import { computed, h, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import type { DataTableColumns } from 'naive-ui';
import { NButton, NSpace, NTag } from 'naive-ui';
import type {
  ResourceColumn,
  ResourceCreate,
  ResourceDelete,
  ResourceField,
  ResourceList,
  ResourcePublish,
  ResourceRow,
  ResourceRowAction,
  ResourceUpdate
} from './resource-crud';
import { ApiError } from '@/service/http';
import { PlatformServiceError } from '@/service/platform';

defineOptions({ name: 'ResourceCrudPage' });

const props = withDefaults(
  defineProps<{
    canPublish?: boolean;
    canWrite?: boolean;
    columns: ResourceColumn[];
    create: ResourceCreate;
    defaults?: Record<string, unknown>;
    description?: string;
    fields: ResourceField[];
    hideCreate?: boolean;
    hideDelete?: boolean;
    hideEdit?: boolean;
    list: ResourceList;
    publish?: ResourcePublish;
    remove: ResourceDelete;
    rowActions?: ResourceRowAction[];
    title: string;
    unpublish?: ResourcePublish;
    update: ResourceUpdate;
  }>(),
  {
    canPublish: false,
    canWrite: false,
    defaults: () => ({}),
    description: '',
    hideCreate: false,
    hideDelete: false,
    hideEdit: false,
    publish: undefined,
    rowActions: () => [],
    unpublish: undefined
  }
);

const loading = ref(false);
const saving = ref(false);
const state = ref<'empty' | 'error' | 'forbidden' | 'loading' | 'ready' | 'unavailable'>('loading');
const rows = ref<ResourceRow[]>([]);
const total = ref(0);
const query = reactive({ limit: 10, page: 1, search: '', sort: '-updatedAt' });
const showEditor = ref(false);
const editingId = ref<ResourceRow['id']>();
const form = reactive<Record<string, unknown>>({});
let controller: AbortController | undefined;

const pagination = computed(() => ({
  page: query.page,
  pageSize: query.limit,
  itemCount: total.value,
  showSizePicker: true,
  pageSizes: [10, 20, 50],
  onChange(page: number) {
    query.page = page;
    void load();
  },
  onUpdatePageSize(limit: number) {
    query.page = 1;
    query.limit = limit;
    void load();
  }
}));

function displayValue(row: ResourceRow, column: ResourceColumn) {
  const value = row[column.key];
  if (column.kind === 'date' && typeof value === 'string') {
    return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
  }
  if (Array.isArray(value)) {
    return value
      .map(item => (item && typeof item === 'object' && 'name' in item ? String(item.name) : String(item)))
      .join('、');
  }
  if (value && typeof value === 'object') {
    if ('name' in value) return String(value.name);
    return JSON.stringify(value);
  }
  return value === null || value === undefined || value === '' ? '—' : String(value);
}

const tableColumns = computed<DataTableColumns<ResourceRow>>(() => {
  const result: DataTableColumns<ResourceRow> = props.columns.map(column => ({
    title: column.label,
    key: column.key,
    width: column.width,
    render: row => {
      const value = row[column.key];
      if (column.kind === 'boolean') {
        return h(NTag, { bordered: false, type: value ? 'success' : 'default' }, () => (value ? '启用' : '停用'));
      }
      if (column.kind === 'status') {
        const published = value === 'published';
        return h(NTag, { bordered: false, type: published ? 'success' : 'warning' }, () =>
          published ? '已发布' : '草稿'
        );
      }
      const option = column.options?.find(item => item.value === value);
      return option?.label || displayValue(row, column);
    }
  }));

  if (props.canWrite || props.canPublish) {
    result.push({
      title: '操作',
      key: 'actions',
      fixed: 'right',
      width: Math.max(220, 120 + props.rowActions.length * 88),
      render: row => {
        const actions: ReturnType<typeof h>[] = [];
        if (props.canWrite) {
          if (!props.hideEdit) {
            actions.push(h(NButton, { text: true, type: 'primary', onClick: () => openEdit(row) }, () => '编辑'));
          }
          if (!props.hideDelete) {
            actions.push(h(NButton, { text: true, type: 'error', onClick: () => confirmDelete(row) }, () => '删除'));
          }
          for (const action of props.rowActions) {
            actions.push(
              h(
                NButton,
                { text: true, type: action.type || 'default', onClick: () => runRowAction(action, row) },
                () => action.label
              )
            );
          }
        }
        if (props.canPublish && row['_status'] !== 'published' && props.publish) {
          actions.push(
            h(NButton, { text: true, type: 'success', onClick: () => changePublish(row, true) }, () => '发布')
          );
        }
        if (props.canPublish && row['_status'] === 'published' && props.unpublish) {
          actions.push(
            h(NButton, { text: true, type: 'warning', onClick: () => changePublish(row, false) }, () => '转为草稿')
          );
        }
        return h(NSpace, { size: 8 }, () => actions);
      }
    });
  }
  return result;
});

function resetForm(row?: ResourceRow) {
  for (const key of Object.keys(form)) Reflect.deleteProperty(form, key);
  Object.assign(form, props.defaults);
  for (const field of props.fields) {
    if (field.writeOnly) {
      form[field.key] = '';
      continue;
    }
    const value = row?.[field.key];
    if (field.type === 'json') form[field.key] = value ? JSON.stringify(value, null, 2) : '';
    else if (value !== undefined && value !== null) form[field.key] = value;
  }
}

function showRequestError(error: unknown) {
  if (error instanceof ApiError) window.$message?.error(error.message);
  if (error instanceof PlatformServiceError) {
    const suffix = error.requestId ? `（请求 ID：${error.requestId}）` : '';
    window.$message?.error(`${error.message}${suffix}`);
  }
}

async function runRowAction(action: ResourceRowAction, row: ResourceRow) {
  try {
    await action.handler(row);
    window.$message?.success(`${action.label}已完成`);
    await load();
  } catch (error) {
    showRequestError(error);
  }
}

function openCreate() {
  editingId.value = undefined;
  resetForm();
  showEditor.value = true;
}

function openEdit(row: ResourceRow) {
  editingId.value = row.id;
  resetForm(row);
  showEditor.value = true;
}

function editorInput(): Record<string, unknown> | undefined {
  const input: Record<string, unknown> = {};
  for (const field of props.fields) {
    let value = form[field.key];
    if (field.required && (value === '' || value === null || value === undefined)) {
      window.$message?.warning(`请填写${field.label}`);
      return undefined;
    }
    if (field.writeOnly && !value) continue;
    if (field.type === 'json' && typeof value === 'string') {
      if (!value.trim()) continue;
      try {
        value = JSON.parse(value);
      } catch {
        window.$message?.warning(`${field.label}必须是合法 JSON`);
        return undefined;
      }
    }
    if (field.type === 'number' && value !== '' && value !== undefined) value = Number(value);
    input[field.key] = value;
  }
  return input;
}

async function save() {
  const input = editorInput();
  if (!input) return;
  saving.value = true;
  try {
    if (editingId.value === undefined) await props.create(input);
    else await props.update(editingId.value, input);
    showEditor.value = false;
    window.$message?.success(editingId.value === undefined ? '创建成功' : '更新成功');
    await load();
  } catch (error) {
    showRequestError(error);
  } finally {
    saving.value = false;
  }
}

function confirmDelete(row: ResourceRow) {
  window.$dialog?.warning({
    title: '确认删除',
    content: `确认删除“${String(row.name || row.id)}”吗？`,
    positiveText: '删除',
    negativeText: '取消',
    async onPositiveClick() {
      try {
        await props.remove(row.id);
        if (rows.value.length === 1 && query.page > 1) query.page -= 1;
        await load();
      } catch (error) {
        showRequestError(error);
      }
    }
  });
}

async function changePublish(row: ResourceRow, publishing: boolean) {
  const action = publishing ? props.publish : props.unpublish;
  if (!action) return;
  try {
    await action(row.id);
    window.$message?.success(publishing ? '发布成功' : '已转为草稿');
    await load();
  } catch (error) {
    showRequestError(error);
  }
}

async function load() {
  controller?.abort();
  controller = new AbortController();
  loading.value = true;
  if (!rows.value.length) state.value = 'loading';
  try {
    const result = await props.list(query, controller.signal);
    rows.value = result.docs;
    total.value = result.totalDocs;
    state.value = result.docs.length ? 'ready' : 'empty';
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return;
    state.value =
      (error instanceof ApiError && error.status === 0) ||
      (error instanceof PlatformServiceError && error.kind === 'backend-unavailable')
        ? 'unavailable'
        : error instanceof PlatformServiceError && error.kind === 'forbidden'
          ? 'forbidden'
          : 'error';
  } finally {
    loading.value = false;
  }
}

function search() {
  query.page = 1;
  void load();
}

onMounted(load);
onBeforeUnmount(() => controller?.abort());
</script>

<template>
  <ResourcePageShell :title="title" :description="description">
    <template #actions>
      <NButton v-if="canWrite && !hideCreate" type="primary" @click="openCreate">新增</NButton>
    </template>
    <template #filters>
      <div class="flex gap-8px lt-sm:flex-col">
        <NInput v-model:value="query.search" clearable placeholder="搜索名称" @clear="search" @keyup.enter="search" />
        <NButton :loading="loading" @click="search">搜索</NButton>
      </div>
    </template>

    <NCard :bordered="false" class="card-wrapper">
      <ResourceState :state="state">
        <template #actions><NButton @click="load">重试</NButton></template>
        <div class="max-w-full overflow-x-auto">
          <NDataTable
            remote
            :columns="tableColumns"
            :data="rows"
            :loading="loading"
            :pagination="pagination"
            :row-key="row => row.id"
            :scroll-x="960"
          />
        </div>
      </ResourceState>
    </NCard>

    <NModal
      v-model:show="showEditor"
      preset="card"
      :title="editingId === undefined ? `新增${title}` : `编辑${title}`"
      class="w-680px max-w-[calc(100vw-32px)]"
    >
      <NForm :model="form" label-placement="top">
        <NGrid :cols="2" :x-gap="16" responsive="screen" item-responsive>
          <NFormItemGi
            v-for="field in fields"
            :key="field.key"
            span="2 s:1"
            :label="field.label"
            :required="field.required"
          >
            <NSwitch
              v-if="field.type === 'switch'"
              :value="Boolean(form[field.key])"
              @update:value="value => (form[field.key] = value)"
            />
            <NSelect
              v-else-if="field.type === 'select'"
              :value="form[field.key] as any"
              :options="field.options"
              :placeholder="field.placeholder"
              @update:value="value => (form[field.key] = value)"
            />
            <NInputNumber
              v-else-if="field.type === 'number'"
              :value="form[field.key] as any"
              class="w-full"
              @update:value="value => (form[field.key] = value)"
            />
            <NInput
              v-else
              v-model:value="form[field.key] as string"
              :type="
                field.type === 'password'
                  ? 'password'
                  : field.type === 'textarea' || field.type === 'json'
                    ? 'textarea'
                    : 'text'
              "
              :rows="field.rows || (field.type === 'json' ? 8 : 3)"
              :placeholder="field.placeholder"
              :show-password-on="field.type === 'password' ? 'click' : undefined"
            />
          </NFormItemGi>
        </NGrid>
      </NForm>
      <template #footer>
        <NSpace justify="end">
          <NButton @click="showEditor = false">取消</NButton>
          <NButton type="primary" :loading="saving" @click="save">保存</NButton>
        </NSpace>
      </template>
    </NModal>
  </ResourcePageShell>
</template>
