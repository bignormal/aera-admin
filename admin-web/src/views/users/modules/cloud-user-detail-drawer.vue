<script setup lang="ts">
import { computed, h, reactive, ref, watch } from 'vue';
import type { DataTableColumns } from 'naive-ui';
import { NButton, NTag } from 'naive-ui';
import { useCapability } from '@/composables/use-capability';
import { useStepUp } from '@/composables/use-step-up';
import { CloudServiceError } from '@/service/cloud';
import {
  disableCloudUser,
  enableCloudUser,
  getCloudOperation,
  getCloudUser,
  getCloudUserMemberships,
  listCloudUserDevices,
  listCloudUserSessions,
  resetCloudUserPassword,
  revokeAllCloudSessions,
  revokeCloudDevice,
  revokeCloudSession,
  type CloudCommandInput,
  type CloudDevice,
  type CloudOperationResult,
  type CloudSession,
  type CloudUser,
  type CloudUserMemberships
} from '@/service/cloud-users';

defineOptions({ name: 'CloudUserDetailDrawer' });

const show = defineModel<boolean>('show', { required: true });
const props = defineProps<{ userId?: string }>();
const emit = defineEmits<{ changed: [] }>();

const { can } = useCapability();
const canUsersWrite = computed(() => can('cloud:users:write'));
const canDevicesWrite = computed(() => can('cloud:devices:write'));
const canSessionsWrite = computed(() => can('cloud:sessions:write'));
const { onStepUpCancelled, onStepUpVerified, runProtected, showStepUp } = useStepUp();

const loading = ref(false);
const user = ref<CloudUser>();
const devices = ref<CloudDevice[]>([]);
const sessions = ref<CloudSession[]>([]);
const memberships = ref<CloudUserMemberships>();
const lastOperation = ref<CloudOperationResult>();
const operationLoading = ref(false);

type CommandKind =
  | { kind: 'disable' }
  | { kind: 'enable' }
  | { kind: 'reset-password' }
  | { deviceId: string; kind: 'revoke-device' }
  | { kind: 'revoke-session'; sessionId: string }
  | { kind: 'revoke-all-sessions' };

const commandTitles: Record<CommandKind['kind'], string> = {
  disable: '禁用用户',
  enable: '启用用户',
  'reset-password': '强制重置密码',
  'revoke-device': '撤销设备',
  'revoke-session': '撤销会话',
  'revoke-all-sessions': '撤销全部会话'
};

const showCommand = ref(false);
const submitting = ref(false);
const pendingCommand = ref<CommandKind>();
const commandForm = reactive<{ note: string; reason_code: string; ticket_reference: string }>({
  note: '',
  reason_code: '',
  ticket_reference: ''
});

function date(value?: string | null) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

function showError(error: unknown) {
  if (error instanceof CloudServiceError) {
    const suffix = error.requestId ? `（请求 ID：${error.requestId}）` : '';
    window.$message?.error(`${error.message}${suffix}`);
  } else if (error instanceof Error) {
    window.$message?.error(error.message);
  }
}

async function load() {
  if (!props.userId) return;
  loading.value = true;
  try {
    const [detail, deviceList, sessionList, membershipData] = await Promise.all([
      getCloudUser(props.userId),
      listCloudUserDevices(props.userId, { limit: 50 }),
      listCloudUserSessions(props.userId, { limit: 50 }),
      getCloudUserMemberships(props.userId)
    ]);
    user.value = detail;
    devices.value = deviceList.items;
    sessions.value = sessionList.items;
    memberships.value = membershipData;
  } catch (error) {
    showError(error);
  } finally {
    loading.value = false;
  }
}

watch(
  () => [show.value, props.userId] as const,
  ([visible]) => {
    if (visible) void load();
  }
);

function openCommand(command: CommandKind) {
  pendingCommand.value = command;
  commandForm.reason_code = '';
  commandForm.ticket_reference = '';
  commandForm.note = '';
  showCommand.value = true;
}

async function refreshLastOperation() {
  if (!lastOperation.value?.operation_id) return;
  operationLoading.value = true;
  try {
    lastOperation.value = await getCloudOperation(lastOperation.value.operation_id);
    window.$message?.success('操作状态已更新');
  } catch (error) {
    showError(error);
  } finally {
    operationLoading.value = false;
  }
}

async function executeCommand() {
  const command = pendingCommand.value;
  if (!command || !user.value) return;
  if (!/^[a-z][a-z0-9_]{2,63}$/.test(commandForm.reason_code)) {
    window.$message?.warning('原因码需为小写字母开头的 3-64 位标识（小写字母/数字/下划线）');
    return;
  }
  const input: CloudCommandInput = {
    expected_revision: Math.max(1, user.value.administrative_revision),
    reason_code: commandForm.reason_code
  };
  if (commandForm.ticket_reference.trim()) input.ticket_reference = commandForm.ticket_reference.trim();
  if (commandForm.note.trim()) input.note = commandForm.note.trim();

  submitting.value = true;
  try {
    const userId = user.value.user_id;
    const result = await runProtected(() => {
      switch (command.kind) {
        case 'disable':
          return disableCloudUser(userId, input);
        case 'enable':
          return enableCloudUser(userId, input);
        case 'reset-password':
          return resetCloudUserPassword(userId, input);
        case 'revoke-device':
          return revokeCloudDevice(command.deviceId, input);
        case 'revoke-session':
          return revokeCloudSession(command.sessionId, input);
        case 'revoke-all-sessions':
        default:
          return revokeAllCloudSessions(userId, input);
      }
    });
    lastOperation.value = result;
    window.$message?.success(`${commandTitles[command.kind]}已提交：${result.operation_id}`);
    showCommand.value = false;
    emit('changed');
    await load();
  } catch (error) {
    showError(error);
  } finally {
    submitting.value = false;
  }
}

const deviceColumns: DataTableColumns<CloudDevice> = [
  { title: '设备', key: 'display_name', minWidth: 150, ellipsis: { tooltip: true } },
  { title: '平台', key: 'platform', width: 100 },
  { title: '版本', key: 'client_version', width: 110 },
  {
    title: '状态',
    key: 'status',
    width: 90,
    render: row =>
      h(NTag, { bordered: false, type: row.status === 'active' ? 'success' : 'default' }, () =>
        row.status === 'active' ? '活跃' : row.status === 'revoked' ? '已撤销' : '闲置'
      )
  },
  { title: '最近在线', key: 'last_seen_at', width: 160, render: row => date(row.last_seen_at) },
  {
    title: '操作',
    key: 'actions',
    width: 90,
    render: row =>
      canDevicesWrite.value && row.status !== 'revoked'
        ? h(
            NButton,
            {
              text: true,
              type: 'error',
              onClick: () => openCommand({ deviceId: row.device_id, kind: 'revoke-device' })
            },
            () => '撤销'
          )
        : '—'
  }
];

const sessionColumns: DataTableColumns<CloudSession> = [
  { title: '会话 ID', key: 'session_id', minWidth: 260, ellipsis: { tooltip: true } },
  {
    title: '状态',
    key: 'status',
    width: 100,
    render: row => h(NTag, { bordered: false, type: row.status === 'active' ? 'success' : 'default' }, () => row.status)
  },
  { title: '签发时间', key: 'issued_at', width: 160, render: row => date(row.issued_at) },
  { title: '过期时间', key: 'expires_at', width: 160, render: row => date(row.expires_at) },
  {
    title: '操作',
    key: 'actions',
    width: 90,
    render: row =>
      canSessionsWrite.value && row.status === 'active'
        ? h(
            NButton,
            {
              text: true,
              type: 'error',
              onClick: () => openCommand({ kind: 'revoke-session', sessionId: row.session_id })
            },
            () => '撤销'
          )
        : '—'
  }
];
</script>

<template>
  <NDrawer v-model:show="show" :width="860" placement="right">
    <NDrawerContent title="云端用户详情" closable>
      <NSpin :show="loading">
        <template v-if="user">
          <NDescriptions :column="2" label-placement="left" bordered size="small" class="mb-16px">
            <NDescriptionsItem label="用户 ID" :span="2">
              <NText code>{{ user.user_id }}</NText>
            </NDescriptionsItem>
            <NDescriptionsItem label="邮箱">{{ user.masked_email || '—' }}</NDescriptionsItem>
            <NDescriptionsItem label="手机号">{{ user.masked_phone || '—' }}</NDescriptionsItem>
            <NDescriptionsItem label="状态">
              <NTag :bordered="false" :type="user.status === 'active' ? 'success' : 'error'">
                {{ user.status === 'active' ? '活跃' : user.status === 'disabled' ? '已禁用' : '待删除' }}
              </NTag>
            </NDescriptionsItem>
            <NDescriptionsItem label="管理修订">{{ user.administrative_revision }}</NDescriptionsItem>
            <NDescriptionsItem label="注册时间">{{ date(user.created_at) }}</NDescriptionsItem>
            <NDescriptionsItem label="最近活动">{{ date(user.last_cloud_activity_at) }}</NDescriptionsItem>
          </NDescriptions>

          <NSpace class="mb-16px">
            <NButton
              v-if="canUsersWrite && user.status === 'active'"
              type="error"
              secondary
              @click="openCommand({ kind: 'disable' })"
            >
              禁用用户
            </NButton>
            <NButton
              v-if="canUsersWrite && user.status === 'disabled'"
              type="success"
              secondary
              @click="openCommand({ kind: 'enable' })"
            >
              启用用户
            </NButton>
            <NButton v-if="canUsersWrite" type="warning" secondary @click="openCommand({ kind: 'reset-password' })">
              强制重置密码
            </NButton>
            <NButton
              v-if="canSessionsWrite"
              type="error"
              tertiary
              @click="openCommand({ kind: 'revoke-all-sessions' })"
            >
              撤销全部会话
            </NButton>
          </NSpace>

          <NAlert v-if="lastOperation" type="info" class="mb-16px" :show-icon="false">
            <NSpace vertical :size="8">
              <div>
                最新云命令：
                <NText code>{{ lastOperation.operation_id }}</NText>
              </div>
              <div>
                状态：{{ lastOperation.status }}；更新时间：{{ date(lastOperation.updated_at) }}；管理修订：{{
                  lastOperation.administrative_revision || '—'
                }}
              </div>
              <NSpace>
                <NButton size="small" :loading="operationLoading" @click="refreshLastOperation">查询状态</NButton>
              </NSpace>
            </NSpace>
          </NAlert>

          <NTabs type="line" animated>
            <NTabPane name="devices" :tab="`设备（${devices.length}）`">
              <NDataTable
                :columns="deviceColumns"
                :data="devices"
                :row-key="row => row.device_id"
                size="small"
                :scroll-x="720"
              />
            </NTabPane>
            <NTabPane name="sessions" :tab="`会话（${sessions.length}）`">
              <NDataTable
                :columns="sessionColumns"
                :data="sessions"
                :row-key="row => row.session_id"
                size="small"
                :scroll-x="780"
              />
            </NTabPane>
            <NTabPane name="memberships" tab="组织与工作区">
              <NDescriptions :column="1" label-placement="top" size="small">
                <NDescriptionsItem label="组织">
                  <NSpace v-if="memberships?.organizations.length" vertical>
                    <div v-for="item in memberships.organizations" :key="item.id">
                      {{ item.display_name }}（{{ item.role }} · {{ item.status }}）
                    </div>
                  </NSpace>
                  <span v-else>—</span>
                </NDescriptionsItem>
                <NDescriptionsItem label="工作区">
                  <NSpace v-if="memberships?.workspaces.length" vertical>
                    <div v-for="item in memberships.workspaces" :key="item.id">
                      {{ item.display_name }}（{{ item.role }} · {{ item.status }}）
                    </div>
                  </NSpace>
                  <span v-else>—</span>
                </NDescriptionsItem>
              </NDescriptions>
            </NTabPane>
          </NTabs>
        </template>
      </NSpin>

      <NModal
        v-model:show="showCommand"
        preset="card"
        :title="pendingCommand ? commandTitles[pendingCommand.kind] : ''"
        class="w-560px max-w-[calc(100vw-32px)]"
      >
        <NAlert v-if="pendingCommand?.kind === 'reset-password'" type="warning" class="mb-12px" :show-icon="false">
          强制重置密码属于高危操作，提交后需要 TOTP 二次验证。
        </NAlert>
        <NForm label-placement="top">
          <NFormItem label="原因码" required>
            <NInput v-model:value="commandForm.reason_code" placeholder="如 abuse_report、user_request" />
          </NFormItem>
          <NFormItem label="工单编号（可选）">
            <NInput v-model:value="commandForm.ticket_reference" />
          </NFormItem>
          <NFormItem label="备注（可选）">
            <NInput v-model:value="commandForm.note" type="textarea" :rows="2" />
          </NFormItem>
        </NForm>
        <template #footer>
          <NSpace justify="end">
            <NButton @click="showCommand = false">取消</NButton>
            <NButton type="primary" :loading="submitting" @click="executeCommand">确认执行</NButton>
          </NSpace>
        </template>
      </NModal>

      <StepUpDialog v-model:show="showStepUp" @verified="onStepUpVerified" @cancelled="onStepUpCancelled" />
    </NDrawerContent>
  </NDrawer>
</template>
