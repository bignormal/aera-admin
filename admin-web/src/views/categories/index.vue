<script setup lang="ts">
import { computed, h, onMounted, reactive, ref } from 'vue';
import type { InputHTMLAttributes } from 'vue';
import type { DataTableColumns, DataTableSortState, FormInst, FormRules } from 'naive-ui';
import { NButton, NSpace, NTag } from 'naive-ui';
import { useCapability } from '@/composables/use-capability';
import { createCategory, deleteCategory, listCategories, updateCategory } from '@/service/categories';
import type { Category, CategoryInput, CategoryQuery } from '@/service/categories';
import { ApiError } from '@/service/http';

defineOptions({ name: 'CategoriesPage' });

const { can } = useCapability();

const loading = ref(false);
const saving = ref(false);
const rows = ref<Category[]>([]);
const total = ref(0);
const query = reactive<CategoryQuery>({ page: 1, pageSize: 10, search: '', sort: 'sortOrder' });
const showEditor = ref(false);
const editingId = ref<Category['id']>();
const formRef = ref<FormInst | null>(null);
const form = reactive<CategoryInput>({
  key: '',
  name: '',
  englishName: '',
  description: '',
  sortOrder: 0,
  active: true
});
const fieldErrors = ref<Record<string, string>>({});
const searchInputProps = { 'data-testid': 'category-search' } as InputHTMLAttributes;
const keyInputProps = { 'data-testid': 'category-key' } as InputHTMLAttributes;
const nameInputProps = { 'data-testid': 'category-name' } as InputHTMLAttributes;
const englishNameInputProps = { 'data-testid': 'category-english-name' } as InputHTMLAttributes;
const sortOrderInputProps = { 'data-testid': 'category-sort-order' } as InputHTMLAttributes;
const descriptionInputProps = { 'data-testid': 'category-description' } as InputHTMLAttributes;

const rules: FormRules = {
  key: [{ required: true, message: '请输入稳定标识', trigger: ['input', 'blur'] }],
  name: [{ required: true, message: '请输入中文名称', trigger: ['input', 'blur'] }],
  sortOrder: [{ type: 'number', required: true, message: '请输入排序值', trigger: ['input', 'blur'] }]
};

const pagination = computed(() => ({
  page: query.page,
  pageSize: query.pageSize,
  itemCount: total.value,
  showSizePicker: true,
  pageSizes: [10, 20, 50],
  onChange(page: number) {
    query.page = page;
    void load();
  },
  onUpdatePageSize(pageSize: number) {
    query.page = 1;
    query.pageSize = pageSize;
    void load();
  }
}));

const columns = computed<DataTableColumns<Category>>(() => [
  {
    title: '中文名称',
    key: 'name',
    sorter: 'default',
    sortOrder: query.sort === 'name' ? 'ascend' : query.sort === '-name' ? 'descend' : false
  },
  { title: '稳定标识', key: 'key' },
  { title: '英文名称', key: 'englishName', render: row => row.englishName || '—' },
  {
    title: '排序',
    key: 'sortOrder',
    sorter: 'default',
    sortOrder: query.sort === 'sortOrder' ? 'ascend' : query.sort === '-sortOrder' ? 'descend' : false
  },
  {
    title: '状态',
    key: 'active',
    render: row =>
      h(NTag, { type: row.active ? 'success' : 'default', bordered: false }, () => (row.active ? '启用' : '停用'))
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
    fixed: 'right',
    width: 150,
    render: row =>
      can('content:categories:write')
        ? h(NSpace, { size: 4 }, () => [
            h(
              NButton,
              { text: true, type: 'primary', 'aria-label': `编辑 ${row.name}`, onClick: () => openEdit(row) },
              () => '编辑'
            ),
            h(
              NButton,
              { text: true, type: 'error', 'aria-label': `删除 ${row.name}`, onClick: () => confirmDelete(row) },
              () => '删除'
            )
          ])
        : '只读'
  }
]);

function resetForm() {
  Object.assign(form, {
    key: '',
    name: '',
    englishName: '',
    description: '',
    sortOrder: 0,
    active: true
  });
  fieldErrors.value = {};
}

function openCreate() {
  editingId.value = undefined;
  resetForm();
  showEditor.value = true;
}

function openEdit(category: Category) {
  editingId.value = category.id;
  Object.assign(form, {
    key: category.key,
    name: category.name,
    englishName: category.englishName || '',
    description: category.description || '',
    sortOrder: category.sortOrder,
    active: category.active
  });
  fieldErrors.value = {};
  showEditor.value = true;
}

async function load() {
  loading.value = true;

  try {
    const result = await listCategories(query);
    rows.value = result.docs;
    total.value = result.totalDocs;
  } catch (error) {
    if (error instanceof ApiError) window.$message?.error(error.message);
  } finally {
    loading.value = false;
  }
}

function search() {
  query.page = 1;
  void load();
}

function handleSorterChange(sorter: DataTableSortState | DataTableSortState[] | null) {
  const current = Array.isArray(sorter) ? sorter[0] : sorter;

  if (!current?.order || (current.columnKey !== 'name' && current.columnKey !== 'sortOrder')) {
    query.sort = 'sortOrder';
  } else {
    const prefix = current.order === 'descend' ? '-' : '';
    query.sort = `${prefix}${current.columnKey}` as CategoryQuery['sort'];
  }

  query.page = 1;
  void load();
}

async function save() {
  try {
    await formRef.value?.validate();
  } catch {
    return;
  }

  const creating = editingId.value === undefined;
  saving.value = true;
  fieldErrors.value = {};

  try {
    if (creating) await createCategory({ ...form });
    else await updateCategory(editingId.value!, { ...form });

    showEditor.value = false;
    window.$message?.success(creating ? '分类已创建' : '分类已更新');
    await load();
  } catch (error) {
    if (error instanceof ApiError) {
      fieldErrors.value = error.fieldErrors || {};
      window.$message?.error(error.message);
    }
  } finally {
    saving.value = false;
  }
}

function confirmDelete(category: Category) {
  window.$dialog?.warning({
    title: '删除分类',
    content: `确认删除“${category.name}”吗？`,
    positiveText: '删除',
    negativeText: '取消',
    async onPositiveClick() {
      try {
        await deleteCategory(category.id);
        window.$message?.success('分类已删除');
        if (rows.value.length === 1 && query.page > 1) query.page -= 1;
        await load();
      } catch (error) {
        if (error instanceof ApiError) window.$message?.error(error.message);
      }
    }
  });
}

onMounted(load);
</script>

<template>
  <NSpace vertical :size="16">
    <div class="flex-y-center justify-between gap-12px lt-sm:flex-col lt-sm:items-stretch">
      <div>
        <h1 class="m-0 text-24px font-600">智能体分类</h1>
        <p class="mb-0 mt-6px text-14px text-gray-500">维护官方智能体的分类与排序</p>
      </div>
      <NButton v-if="can('content:categories:write')" data-testid="category-create" type="primary" @click="openCreate">
        创建分类
      </NButton>
    </div>

    <NCard :bordered="false" class="card-wrapper">
      <div class="mb-16px flex gap-8px lt-sm:flex-col">
        <NInput
          v-model:value="query.search"
          :input-props="searchInputProps"
          clearable
          placeholder="搜索中文名称"
          @clear="search"
          @keyup.enter="search"
        />
        <NButton @click="search">搜索</NButton>
      </div>
      <div class="max-w-full overflow-x-auto">
        <NDataTable
          remote
          :columns="columns"
          :data="rows"
          :loading="loading"
          :pagination="pagination"
          :row-key="row => row.id"
          :scroll-x="960"
          @update:sorter="handleSorterChange"
        />
      </div>
    </NCard>

    <NModal
      v-model:show="showEditor"
      preset="card"
      :title="editingId === undefined ? '创建分类' : '编辑分类'"
      class="w-600px max-w-[calc(100vw-32px)]"
    >
      <NForm ref="formRef" :model="form" :rules="rules" label-placement="top">
        <NGrid :cols="2" :x-gap="16" responsive="screen" item-responsive>
          <NFormItemGi
            span="2 s:1"
            label="稳定标识"
            path="key"
            :validation-status="fieldErrors.key ? 'error' : undefined"
            :feedback="fieldErrors.key"
          >
            <NInput v-model:value="form.key" :input-props="keyInputProps" placeholder="例如 marketing" />
          </NFormItemGi>
          <NFormItemGi
            span="2 s:1"
            label="中文名称"
            path="name"
            :validation-status="fieldErrors.name ? 'error' : undefined"
            :feedback="fieldErrors.name"
          >
            <NInput v-model:value="form.name" :input-props="nameInputProps" />
          </NFormItemGi>
          <NFormItemGi span="2 s:1" label="英文名称" path="englishName">
            <NInput v-model:value="form.englishName" :input-props="englishNameInputProps" />
          </NFormItemGi>
          <NFormItemGi span="2 s:1" label="排序" path="sortOrder">
            <NInputNumber
              :value="form.sortOrder"
              :input-props="sortOrderInputProps"
              class="w-full"
              @update:value="value => (form.sortOrder = value ?? 0)"
            />
          </NFormItemGi>
          <NFormItemGi :span="2" label="分类说明" path="description">
            <NInput v-model:value="form.description" :input-props="descriptionInputProps" type="textarea" :rows="3" />
          </NFormItemGi>
          <NFormItemGi :span="2" label="状态" path="active">
            <NCheckbox v-model:checked="form.active" data-testid="category-active">启用</NCheckbox>
          </NFormItemGi>
        </NGrid>
      </NForm>
      <template #footer>
        <div class="flex justify-end gap-8px">
          <NButton @click="showEditor = false">取消</NButton>
          <NButton type="primary" :loading="saving" @click="save">保存</NButton>
        </div>
      </template>
    </NModal>
  </NSpace>
</template>
