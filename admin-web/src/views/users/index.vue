<script setup lang="ts">
import { computed, h, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import type { DataTableColumns, DataTableSortState } from 'naive-ui';
import { NButton, NSpace, NTag } from 'naive-ui';
import CloudUsersPanel from './modules/cloud-users-panel.vue';
import UserAttributeDefinitionsPanel from './modules/user-attribute-definitions-panel.vue';
import UserBalanceDialog from './modules/balance-dialog.vue';
import UserDetailDrawer from './modules/user-detail-drawer.vue';
import { useCapability } from '@/composables/use-capability';
import { PlatformServiceError } from '@/service/platform';
import {
  batchUpdateUserConcurrency,
  createUser,
  listUsers,
  replaceUserGroup,
  updateUser,
  updateUserStatus,
  type PlatformUser,
  type UserInput,
  type UserRole,
  type UserStatus
} from '@/service/users';

defineOptions({ name: 'UsersPage' });

const { can } = useCapability();
const canWrite = computed(() => can('users:write'));
const canBalance = computed(() => can('users:balance:update'));
const canCloudRead = computed(() => can('cloud:users:read'));
const activeTab = ref<'attributes' | 'cloud' | 'platform'>('platform');
const checkedUserIds = ref<number[]>([]);
const loading = ref(false);
const saving = ref(false);
const state = ref<'empty' | 'error' | 'forbidden' | 'loading' | 'ready' | 'unavailable'>('loading');
const rows = ref<PlatformUser[]>([]);
const total = ref(0);
const query = reactive<{
  page: number;
  pageSize: number;
  role?: UserRole;
  search: string;
  sortBy: string;
  sortOrder: 'asc' | 'desc';
  status?: UserStatus;
}>({ page: 1, pageSize: 20, search: '', sortBy: 'created_at', sortOrder: 'desc' });
const showEditor = ref(false);
const editing = ref<PlatformUser>();
const showDetail = ref(false);
const detailUserId = ref<number>();
const showBalance = ref(false);
const balanceUser = ref<PlatformUser>();
const form = reactive<UserInput>({
  email: '',
  password: '',
  role: 'user',
  status: 'active',
  concurrency: 1,
  rpm_limit: 0
});
let controller: AbortController | undefined;

function date(value: string) {
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

function openDetail(row: PlatformUser) {
  detailUserId.value = row.id;
  showDetail.value = true;
}

function openBalance(row: PlatformUser) {
  balanceUser.value = row;
  showBalance.value = true;
}

async function batchConcurrency() {
  if (!checkedUserIds.value.length) return window.$message?.warning('请先选择用户。');
  const value = window.prompt('请输入新的并发上限', '5');
  if (value === null) return;
  const concurrency = Number(value);
  if (!Number.isInteger(concurrency) || concurrency < 0) return window.$message?.warning('并发上限必须是非负整数。');
  try {
    await batchUpdateUserConcurrency({ concurrency, user_ids: checkedUserIds.value });
    window.$message?.success('批量并发已更新');
    checkedUserIds.value = [];
    await load();
  } catch (error) {
    showError(error);
  }
}

async function replaceGroupForSelected() {
  if (!checkedUserIds.value.length) return window.$message?.warning('请先选择用户。');
  const value = window.prompt('请输入目标分组 ID；留空表示清空用户分组', '');
  if (value === null) return;
  const groupId = value.trim() ? Number(value) : null;
  if (groupId !== null && (!Number.isInteger(groupId) || groupId < 0)) return window.$message?.warning('分组 ID 必须是非负整数。');
  try {
    await Promise.all(checkedUserIds.value.map(id => replaceUserGroup(id, { group_id: groupId })));
    window.$message?.success('用户分组已替换');
    checkedUserIds.value = [];
    await load();
  } catch (error) {
    showError(error);
  }
}

function openCreate() {
  editing.value = undefined;
  Object.assign(form, {
    email: '',
    password: '',
    username: '',
    notes: '',
    role: 'user',
    status: 'active',
    balance: 0,
    concurrency: 1,
    rpm_limit: 0
  });
  showEditor.value = true;
}

function openEdit(row: PlatformUser) {
  editing.value = row;
  Object.assign(form, {
    email: row.email,
    password: '',
    username: row.username,
    notes: row.notes,
    role: row.role,
    status: row.status,
    concurrency: row.concurrency,
    rpm_limit: row.rpm_limit || 0
  });
  showEditor.value = true;
}

async function toggleStatus(row: PlatformUser) {
  const next = row.status === 'active' ? 'disabled' : 'active';
  try {
    await updateUserStatus(row.id, next);
    window.$message?.success(next === 'active' ? '用户已启用' : '用户已停用');
    await load();
  } catch (error) {
    showError(error);
  }
}

function showError(error: unknown) {
  if (error instanceof PlatformServiceError) {
    const suffix = error.requestId ? `（请求 ID：${error.requestId}）` : '';
    window.$message?.error(`${error.message}${suffix}`);
  }
}

async function save() {
  if (!form.email.trim()) return window.$message?.warning('请填写邮箱');
  if (!editing.value && !form.password) return window.$message?.warning('新用户必须设置密码');
  saving.value = true;
  try {
    const input = { ...form };
    if (!input.password) delete input.password;
    if (editing.value) await updateUser(editing.value.id, input);
    else await createUser(input);
    showEditor.value = false;
    window.$message?.success(editing.value ? '用户已更新' : '用户已创建');
    await load();
  } catch (error) {
    showError(error);
  } finally {
    saving.value = false;
  }
}

const columns: DataTableColumns<PlatformUser> = [
  { type: 'selection', disabled: () => !canWrite.value },
  { title: 'ID', key: 'id', width: 74, sorter: true },
  { title: '邮箱', key: 'email', minWidth: 220, ellipsis: { tooltip: true } },
  { title: '用户名', key: 'username', minWidth: 130, ellipsis: { tooltip: true } },
  { title: '余额', key: 'balance', width: 120, sorter: true, render: row => Number(row.balance).toFixed(4) },
  {
    title: '并发 / RPM',
    key: 'concurrency',
    width: 130,
    render: row => `${row.current_concurrency || 0}/${row.concurrency} · ${row.rpm_limit || '∞'}`
  },
  {
    title: '状态',
    key: 'status',
    width: 90,
    render: row =>
      h(NTag, { bordered: false, type: row.status === 'active' ? 'success' : 'default' }, () =>
        row.status === 'active' ? '启用' : '停用'
      )
  },
  {
    title: '最近活跃',
    key: 'last_active_at',
    width: 180,
    sorter: true,
    render: row => (row.last_active_at ? date(row.last_active_at) : '—')
  },
  {
    title: '操作',
    key: 'actions',
    fixed: 'right',
    width: 280,
    render: row =>
      h(NSpace, { size: 10 }, () => [
        h(NButton, { text: true, type: 'primary', onClick: () => openDetail(row) }, () => '详情'),
        canWrite.value ? h(NButton, { text: true, onClick: () => openEdit(row) }, () => '编辑') : null,
        canBalance.value
          ? h(NButton, { text: true, type: 'warning', onClick: () => openBalance(row) }, () => '调余额')
          : null,
        canWrite.value
          ? h(
              NButton,
              { text: true, type: row.status === 'active' ? 'error' : 'success', onClick: () => toggleStatus(row) },
              () => (row.status === 'active' ? '停用' : '启用')
            )
          : null
      ])
  }
];

const pagination = computed(() => ({
  page: query.page,
  pageSize: query.pageSize,
  itemCount: total.value,
  showSizePicker: true,
  pageSizes: [10, 20, 50, 100],
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

function search() {
  query.page = 1;
  void load();
}

function sort(sorter: DataTableSortState | DataTableSortState[] | null) {
  if (!sorter || Array.isArray(sorter) || !sorter.order) return;
  const fields: Record<string, string> = { id: 'id', balance: 'balance', last_active_at: 'last_active_at' };
  query.sortBy = fields[String(sorter.columnKey)] || 'created_at';
  query.sortOrder = sorter.order === 'ascend' ? 'asc' : 'desc';
  search();
}

async function load() {
  controller?.abort();
  controller = new AbortController();
  loading.value = true;
  if (!rows.value.length) state.value = 'loading';
  try {
    const result = await listUsers(query, controller.signal);
    rows.value = result.docs;
    total.value = result.totalDocs;
    state.value = rows.value.length ? 'ready' : 'empty';
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return;
    if (error instanceof PlatformServiceError && error.kind === 'forbidden') state.value = 'forbidden';
    else if (error instanceof PlatformServiceError && error.kind === 'backend-unavailable') state.value = 'unavailable';
    else state.value = 'error';
  } finally {
    loading.value = false;
  }
}

onMounted(load);
onBeforeUnmount(() => controller?.abort());
</script>

<template>
  <ResourcePageShell
    title="用户管理"
    description="平台用户由 AgentEra API 持有；云端用户/设备/会话由 aera-cloud 内部管理 API 持有，本后台统一管控"
  >
    <template #actions>
      <NButton v-if="canWrite && activeTab === 'platform'" type="primary" @click="openCreate">创建用户</NButton>
      <NButton v-if="canWrite && activeTab === 'platform'" :disabled="!checkedUserIds.length" @click="batchConcurrency">
        批量并发
      </NButton>
      <NButton v-if="canWrite && activeTab === 'platform'" :disabled="!checkedUserIds.length" @click="replaceGroupForSelected">
        替换分组
      </NButton>
    </template>

    <NTabs v-model:value="activeTab" type="line" animated>
      <NTabPane name="platform" tab="平台用户">
        <div class="grid grid-cols-1 mb-16px gap-12px md:grid-cols-[minmax(260px,1fr)_160px_160px_auto]">
          <NInput
            v-model:value="query.search"
            clearable
            placeholder="搜索邮箱或用户名"
            @clear="search"
            @keyup.enter="search"
          />
          <NSelect
            v-model:value="query.status"
            clearable
            placeholder="全部状态"
            :options="[
              { label: '启用', value: 'active' },
              { label: '停用', value: 'disabled' }
            ]"
            @update:value="search"
          />
          <NSelect
            v-model:value="query.role"
            clearable
            placeholder="全部角色"
            :options="[
              { label: '普通用户', value: 'user' },
              { label: '业务管理员', value: 'admin' }
            ]"
            @update:value="search"
          />
          <NButton :loading="loading" @click="search">搜索</NButton>
        </div>

        <NCard :bordered="false" class="card-wrapper">
          <ResourceState :state="state">
            <template #actions><NButton @click="load">重试</NButton></template>
            <NDataTable
              remote
              :columns="columns"
              :data="rows"
              :checked-row-keys="checkedUserIds"
              :loading="loading"
              :pagination="pagination"
              :row-key="row => row.id"
              :scroll-x="1320"
              data-testid="platform-users-table"
              @update:checked-row-keys="keys => (checkedUserIds = keys.map(Number))"
              @update:sorter="sort"
            />
          </ResourceState>
        </NCard>
      </NTabPane>
      <NTabPane name="attributes" tab="用户属性">
        <NCard :bordered="false" class="card-wrapper">
          <UserAttributeDefinitionsPanel />
        </NCard>
      </NTabPane>
      <NTabPane v-if="canCloudRead" name="cloud" tab="云端用户">
        <NCard :bordered="false" class="card-wrapper">
          <CloudUsersPanel />
        </NCard>
      </NTabPane>
    </NTabs>

    <NModal
      v-model:show="showEditor"
      preset="card"
      :title="editing ? '编辑用户' : '创建用户'"
      class="w-720px max-w-[calc(100vw-32px)]"
    >
      <NForm :model="form" label-placement="top">
        <NGrid cols="1 s:2" responsive="screen" :x-gap="16">
          <NFormItemGi label="邮箱" required><NInput v-model:value="form.email" /></NFormItemGi>
          <NFormItemGi :label="editing ? '新密码（留空不修改）' : '登录密码'" :required="!editing">
            <NInput v-model:value="form.password" type="password" show-password-on="click" />
          </NFormItemGi>
          <NFormItemGi label="用户名"><NInput v-model:value="form.username" /></NFormItemGi>
          <NFormItemGi label="角色">
            <NSelect
              v-model:value="form.role"
              :options="[
                { label: '普通用户', value: 'user' },
                { label: '业务管理员', value: 'admin' }
              ]"
            />
          </NFormItemGi>
          <NFormItemGi label="并发上限">
            <NInputNumber v-model:value="form.concurrency" :min="0" class="w-full" />
          </NFormItemGi>
          <NFormItemGi label="RPM 上限（0 表示不限）">
            <NInputNumber v-model:value="form.rpm_limit" :min="0" class="w-full" />
          </NFormItemGi>
          <NFormItemGi label="状态">
            <NSelect
              v-model:value="form.status"
              :options="[
                { label: '启用', value: 'active' },
                { label: '停用', value: 'disabled' }
              ]"
            />
          </NFormItemGi>
          <NFormItemGi v-if="!editing" label="初始余额">
            <NInputNumber v-model:value="form.balance" :min="0" :precision="4" class="w-full" />
          </NFormItemGi>
          <NFormItemGi label="管理员备注" span="2">
            <NInput v-model:value="form.notes" type="textarea" :rows="3" />
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

    <UserDetailDrawer v-model:show="showDetail" :user-id="detailUserId" />
    <UserBalanceDialog v-model:show="showBalance" :user="balanceUser" @saved="load" />
  </ResourcePageShell>
</template>
