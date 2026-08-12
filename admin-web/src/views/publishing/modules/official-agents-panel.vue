<script setup lang="ts">
import { computed, h, onMounted, reactive, ref } from 'vue';
import type { VNodeChild } from 'vue';
import type { DataTableColumns } from 'naive-ui';
import { NButton, NSpace, NTag, NText } from 'naive-ui';
import { useCapability } from '@/composables/use-capability';
import { useStepUp } from '@/composables/use-step-up';
import { useAuthStore } from '@/store/modules/auth';
import { CloudServiceError } from '@/service/cloud';
import {
  activateOfficialRelease,
  cancelRollbackRequest,
  createOfficialDraft,
  createRollbackRequest,
  decideRollbackRequest,
  executeOfficialRollback,
  listOfficialAgentAuditEvents,
  listOfficialDefinitions,
  listOfficialDrafts,
  listOfficialReleases,
  listOfficialSubmissions,
  listOfficialVersions,
  listRollbackRequests,
  officialWorkbenchState,
  releaseActionsFor,
  pauseOfficialRelease,
  reserveOfficialDefinition,
  resumeOfficialRelease,
  reviewOfficialSubmission,
  rolloutOfficialRelease,
  submitOfficialDraft,
  updateOfficialDraft,
  validateOfficialDraft,
  withdrawOfficialSubmission,
  type OfficialAgentAuditEvent,
  type OfficialDefinition,
  type OfficialDraft,
  type OfficialRelease,
  type OfficialReleaseChannel,
  type OfficialReviewDecision,
  type OfficialSubmission,
  type OfficialVersion,
  type RollbackRequest
} from '@/service/cloud-official-agents';
import {
  buildOfficialDraftCreatePayload,
  buildOfficialDraftUpdatePayload,
  buildOfficialReviewPayload
} from '@/service/official-agent-forms';

defineOptions({ name: 'OfficialAgentsPanel' });

const { can } = useCapability();
const authStore = useAuthStore();
const canRead = computed(() => can('official-agents:read'));
const canDraft = computed(() => can('official-agents:draft:write'));
const canReview = computed(() => can('official-agents:review:write'));
const canRelease = computed(() => can('official-agents:release:write'));
const canRollback = computed(() => can('official-agents:rollback:write'));
const releaseActions = (row: OfficialRelease) => {
  if (!canRelease.value) return [];
  return releaseActionsFor({ role: authStore.userInfo.role, status: row.state });
};
const { onStepUpCancelled, onStepUpVerified, runProtected, showStepUp } = useStepUp();

const loading = ref(false);
const state = ref<'error' | 'forbidden' | 'loading' | 'ready' | 'unavailable'>('loading');
const definitions = ref<OfficialDefinition[]>([]);
const drafts = ref<OfficialDraft[]>([]);
const submissions = ref<OfficialSubmission[]>([]);
const versions = ref<OfficialVersion[]>([]);
const releases = ref<OfficialRelease[]>([]);
const rollbacks = ref<RollbackRequest[]>([]);
const auditEvents = ref<OfficialAgentAuditEvent[]>([]);

const workbenchState = computed(() =>
  officialWorkbenchState([
    { items: definitions.value },
    { items: drafts.value },
    { items: submissions.value },
    { items: versions.value },
    { items: releases.value },
    { items: auditEvents.value }
  ])
);

function date(value?: string | null) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

function short(value?: string) {
  return value ? `${value.slice(0, 8)}…` : '—';
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
  loading.value = true;
  if (state.value !== 'ready') state.value = 'loading';
  try {
    const [definitionPage, draftPage, submissionPage, versionPage, releasePage, auditPage, rollbackList] =
      await Promise.all([
        listOfficialDefinitions({ limit: 50 }),
        listOfficialDrafts({ limit: 50 }),
        listOfficialSubmissions({ limit: 50 }),
        listOfficialVersions({ limit: 50 }),
        listOfficialReleases({ limit: 50 }),
        listOfficialAgentAuditEvents({ limit: 50 }),
        listRollbackRequests().catch(() => [] as RollbackRequest[])
      ]);
    definitions.value = definitionPage.items;
    drafts.value = draftPage.items;
    submissions.value = submissionPage.items;
    versions.value = versionPage.items;
    releases.value = releasePage.items;
    auditEvents.value = auditPage.items;
    rollbacks.value = rollbackList;
    state.value = 'ready';
  } catch (error) {
    if (error instanceof CloudServiceError && error.kind === 'forbidden') state.value = 'forbidden';
    else if (error instanceof CloudServiceError && error.kind === 'backend-unavailable') state.value = 'unavailable';
    else state.value = 'error';
    showError(error);
  } finally {
    loading.value = false;
  }
}

// ---- 通用操作对话框 ----
type ActionKind =
  | 'activate-release'
  | 'create-definition'
  | 'create-draft'
  | 'create-rollback'
  | 'review-submission'
  | 'rollout-release'
  | 'simple-release'
  | 'submit-draft'
  | 'update-draft'
  | 'withdraw-submission';

const showAction = ref(false);
const submitting = ref(false);
const actionKind = ref<ActionKind>('create-definition');
const actionTitle = ref('');
const actionTarget = ref<{
  draft?: OfficialDraft;
  release?: OfficialRelease;
  releaseAction?: 'pause' | 'resume';
  submission?: OfficialSubmission;
}>({});

const reasonForm = reactive({ note: '', reason_code: '', ticket_reference: '' });
const definitionForm = reactive({ display_name: '' });
const draftForm = reactive({
  baseVersionId: '',
  bundleJSON: '{}',
  definition_id: '',
  display_name: '',
  kind: 'initial' as OfficialDraft['kind'],
  manifestJSON: '{}'
});
const reviewForm = reactive({
  decision: 'approve' as OfficialReviewDecision,
  initial_channels: ['stable'] as OfficialReleaseChannel[],
  review_reason_code: '',
  safe_note: ''
});
const releaseForm = reactive({
  minimum_desktop_version: '0.1.0',
  rollout_basis_points: 10000,
  version_id: ''
});
const rollbackForm = reactive({ target_release_revision_id: '', target_version_id: '' });

function resetReason() {
  reasonForm.reason_code = '';
  reasonForm.ticket_reference = '';
  reasonForm.note = '';
}

function openAction(kind: ActionKind, title: string, target: typeof actionTarget.value = {}) {
  actionKind.value = kind;
  actionTitle.value = title;
  actionTarget.value = target;
  resetReason();
  if (kind === 'update-draft' && target.draft) {
    draftForm.baseVersionId = target.draft.base_version_id || '';
    draftForm.manifestJSON = JSON.stringify(target.draft.manifest, null, 2);
    draftForm.bundleJSON = JSON.stringify(target.draft.bundle, null, 2);
    draftForm.display_name = target.draft.display_name;
    draftForm.kind = target.draft.kind;
  }
  if (kind === 'create-draft') {
    draftForm.baseVersionId = '';
    draftForm.definition_id = definitions.value[0]?.definition_id || '';
    draftForm.display_name = '';
    draftForm.kind = 'initial';
    draftForm.manifestJSON = '{}';
    draftForm.bundleJSON = '{}';
  }
  if (kind === 'review-submission') {
    reviewForm.decision = 'approve';
    reviewForm.initial_channels = ['stable'];
    reviewForm.review_reason_code = '';
    reviewForm.safe_note = '';
  }
  if (kind === 'activate-release' && target.release) {
    releaseForm.version_id = target.release.agent_version_id;
    releaseForm.rollout_basis_points = 10000;
    releaseForm.minimum_desktop_version = target.release.minimum_desktop_version || '0.1.0';
  }
  if (kind === 'rollout-release' && target.release) {
    releaseForm.rollout_basis_points = target.release.rollout_basis_points;
    releaseForm.minimum_desktop_version = target.release.minimum_desktop_version;
  }
  if (kind === 'create-rollback') {
    rollbackForm.target_version_id = '';
    rollbackForm.target_release_revision_id = '';
  }
  showAction.value = true;
}

function reasonInput<TPayload extends Record<string, unknown>>(revision: number, payload: TPayload) {
  const input: {
    expected_revision: number;
    payload: TPayload;
    reason_code: string;
    ticket_reference?: string;
  } = { expected_revision: revision, payload, reason_code: reasonForm.reason_code };
  if (reasonForm.ticket_reference.trim()) input.ticket_reference = reasonForm.ticket_reference.trim();
  return input;
}

async function performAction() {
  if (!/^[a-z][a-z0-9_]{2,63}$/.test(reasonForm.reason_code)) {
    window.$message?.warning('原因码需为小写字母开头的 3-64 位标识（小写字母/数字/下划线）');
    return;
  }
  submitting.value = true;
  try {
    switch (actionKind.value) {
      case 'create-definition': {
        if (!definitionForm.display_name.trim()) {
          window.$message?.warning('请填写名称');
          return;
        }
        await reserveOfficialDefinition(reasonInput(1, { display_name: definitionForm.display_name.trim() }));
        break;
      }
      case 'create-draft': {
        const result = buildOfficialDraftCreatePayload({
          baseVersionId: draftForm.baseVersionId,
          bundleJSON: draftForm.bundleJSON,
          definitionId: draftForm.definition_id,
          displayName: draftForm.display_name,
          kind: draftForm.kind,
          manifestJSON: draftForm.manifestJSON
        });
        if (!result.ok) {
          window.$message?.warning(result.error);
          return;
        }
        await createOfficialDraft(reasonInput(1, result.payload));
        break;
      }
      case 'update-draft': {
        const draft = actionTarget.value.draft;
        if (!draft) return;
        const result = buildOfficialDraftUpdatePayload({
          baseVersionId: draftForm.baseVersionId,
          bundleJSON: draftForm.bundleJSON,
          displayName: draftForm.display_name,
          kind: draftForm.kind,
          manifestJSON: draftForm.manifestJSON
        });
        if (!result.ok) {
          window.$message?.warning(result.error);
          return;
        }
        await updateOfficialDraft(draft.draft_id, reasonInput(draft.revision, result.payload));
        break;
      }
      case 'submit-draft': {
        const draft = actionTarget.value.draft;
        if (!draft) return;
        await submitOfficialDraft(draft.draft_id, reasonInput(draft.revision, {}));
        break;
      }
      case 'withdraw-submission': {
        const submission = actionTarget.value.submission;
        if (!submission) return;
        await withdrawOfficialSubmission(submission.submission_id, reasonInput(submission.revision, {}));
        break;
      }
      case 'review-submission': {
        const submission = actionTarget.value.submission;
        if (!submission) return;
        const result = buildOfficialReviewPayload({
          decision: reviewForm.decision,
          initialChannels: reviewForm.initial_channels,
          reviewReasonCode: reviewForm.review_reason_code,
          safeNote: reviewForm.safe_note
        });
        if (!result.ok) {
          window.$message?.warning(result.error);
          return;
        }
        await reviewOfficialSubmission(submission.submission_id, reasonInput(submission.revision, result.payload));
        break;
      }
      case 'activate-release': {
        const release = actionTarget.value.release;
        if (!release || !releaseForm.version_id) {
          window.$message?.warning('请选择要激活的版本');
          return;
        }
        await activateOfficialRelease(
          release.release_id,
          reasonInput(release.head_revision, {
            minimum_desktop_version: releaseForm.minimum_desktop_version,
            rollout_basis_points: releaseForm.rollout_basis_points,
            version_id: releaseForm.version_id
          })
        );
        break;
      }
      case 'rollout-release': {
        const release = actionTarget.value.release;
        if (!release) return;
        await rolloutOfficialRelease(
          release.release_id,
          reasonInput(release.head_revision, {
            minimum_desktop_version: releaseForm.minimum_desktop_version,
            rollout_basis_points: releaseForm.rollout_basis_points
          })
        );
        break;
      }
      case 'simple-release': {
        const release = actionTarget.value.release;
        const releaseAction = actionTarget.value.releaseAction;
        if (!release || !releaseAction) return;
        const input = reasonInput(release.head_revision, {});
        if (releaseAction === 'pause') await pauseOfficialRelease(release.release_id, input);
        else await resumeOfficialRelease(release.release_id, input);
        break;
      }
      case 'create-rollback': {
        const release = actionTarget.value.release;
        if (!release || !rollbackForm.target_version_id || !rollbackForm.target_release_revision_id) {
          window.$message?.warning('请填写回滚目标版本与目标发布修订');
          return;
        }
        await createRollbackRequest({
          expected_revision: release.head_revision,
          reason_code: reasonForm.reason_code,
          release_id: release.release_id,
          target_release_revision_id: rollbackForm.target_release_revision_id,
          target_version_id: rollbackForm.target_version_id,
          ticket_reference: reasonForm.ticket_reference.trim() || undefined
        });
        break;
      }
      default:
        return;
    }
    window.$message?.success(`${actionTitle.value}已提交`);
    showAction.value = false;
    await load();
  } catch (error) {
    showError(error);
  } finally {
    submitting.value = false;
  }
}

async function runValidate(draft: OfficialDraft) {
  try {
    const result = await validateOfficialDraft(draft.draft_id);
    if (result.valid) window.$message?.success('草稿校验通过（DLP 无发现）');
    else window.$message?.warning(`草稿校验未通过：${result.findings.length} 个发现`);
  } catch (error) {
    showError(error);
  }
}

async function decideRollback(row: RollbackRequest, decision: 'approve' | 'reject') {
  try {
    await decideRollbackRequest(row.id, decision);
    window.$message?.success(decision === 'approve' ? '已批准回滚' : '已拒绝回滚');
    await load();
  } catch (error) {
    showError(error);
  }
}

async function cancelRollback(row: RollbackRequest) {
  try {
    await cancelRollbackRequest(row.id);
    window.$message?.success('已取消回滚审批');
    await load();
  } catch (error) {
    showError(error);
  }
}

async function executeRollback(row: RollbackRequest) {
  try {
    await runProtected(() => executeOfficialRollback(row.releaseId, row.approvalId));
    window.$message?.success('回滚已执行');
    await load();
  } catch (error) {
    showError(error);
  }
}

// ---- 表格列 ----
const definitionColumns: DataTableColumns<OfficialDefinition> = [
  { title: '名称', key: 'display_name', minWidth: 160, ellipsis: { tooltip: true } },
  { title: '定义 ID', key: 'definition_id', minWidth: 280, ellipsis: { tooltip: true } },
  { title: '状态', key: 'status', width: 110, render: row => h(NTag, { bordered: false }, () => row.status) },
  { title: '最新版本', key: 'latest_version_id', width: 110, render: row => short(row.latest_version_id) },
  { title: '更新时间', key: 'updated_at', width: 170, render: row => date(row.updated_at) }
];

const draftColumns: DataTableColumns<OfficialDraft> = [
  { title: '名称', key: 'display_name', minWidth: 150, ellipsis: { tooltip: true } },
  { title: '草稿 ID', key: 'draft_id', width: 110, render: row => short(row.draft_id) },
  { title: '类型', key: 'kind', width: 110 },
  { title: '修订', key: 'revision', width: 70 },
  { title: '状态', key: 'status', width: 110, render: row => h(NTag, { bordered: false }, () => row.status) },
  { title: '更新时间', key: 'updated_at', width: 170, render: row => date(row.updated_at) },
  {
    title: '操作',
    key: 'actions',
    width: 240,
    render: row =>
      canDraft.value
        ? h(NSpace, { size: 8 }, () => [
            h(NButton, { text: true, onClick: () => runValidate(row) }, () => '校验'),
            h(
              NButton,
              { text: true, type: 'primary', onClick: () => openAction('update-draft', '更新草稿', { draft: row }) },
              () => '编辑'
            ),
            h(
              NButton,
              { text: true, type: 'success', onClick: () => openAction('submit-draft', '提交审核', { draft: row }) },
              () => '提交审核'
            )
          ])
        : '只读'
  }
];

const submissionColumns: DataTableColumns<OfficialSubmission> = [
  { title: '名称', key: 'display_name', minWidth: 150, ellipsis: { tooltip: true } },
  { title: '提交 ID', key: 'submission_id', width: 110, render: row => short(row.submission_id) },
  {
    title: '状态',
    key: 'status',
    width: 130,
    render: row =>
      h(
        NTag,
        {
          bordered: false,
          type: row.status === 'approved' ? 'success' : row.status === 'rejected' ? 'error' : 'warning'
        },
        () => row.status
      )
  },
  { title: '提交时间', key: 'submitted_at', width: 170, render: row => date(row.submitted_at) },
  {
    title: '审核',
    key: 'review',
    minWidth: 160,
    render: row => (row.review ? `${row.review.decision}（${date(row.review.reviewed_at)}）` : '—')
  },
  {
    title: '操作',
    key: 'actions',
    width: 190,
    render: row => {
      const buttons: VNodeChild[] = [];
      if (canReview.value && row.status === 'pending') {
        buttons.push(
          h(
            NButton,
            {
              text: true,
              type: 'primary',
              onClick: () => openAction('review-submission', '审核提交', { submission: row })
            },
            () => '审核'
          )
        );
      }
      if (canDraft.value && row.status === 'pending') {
        buttons.push(
          h(
            NButton,
            {
              text: true,
              type: 'warning',
              onClick: () => openAction('withdraw-submission', '撤回提交', { submission: row })
            },
            () => '撤回'
          )
        );
      }
      return buttons.length ? h(NSpace, { size: 8 }, () => buttons) : '—';
    }
  }
];

const releaseColumns: DataTableColumns<OfficialRelease> = [
  { title: '发布 ID', key: 'release_id', width: 110, render: row => short(row.release_id) },
  { title: '渠道', key: 'channel', width: 90 },
  {
    title: '状态',
    key: 'state',
    width: 110,
    render: row =>
      h(
        NTag,
        { bordered: false, type: row.state === 'active' ? 'success' : row.state === 'paused' ? 'warning' : 'default' },
        () => row.state
      )
  },
  {
    title: '灰度',
    key: 'rollout_basis_points',
    width: 90,
    render: row => `${(row.rollout_basis_points / 100).toFixed(1)}%`
  },
  { title: '版本', key: 'agent_version_id', width: 110, render: row => short(row.agent_version_id) },
  { title: '头修订', key: 'head_revision', width: 80 },
  { title: '更新时间', key: 'updated_at', width: 170, render: row => date(row.updated_at) },
  {
    title: '操作',
    key: 'actions',
    width: 320,
    render: row => {
      const actions = releaseActions(row);
      return canRollback.value || actions.length
        ? h(NSpace, { size: 8 }, () => [
            actions.includes('activate')
              ? h(
                  NButton,
                  {
                    text: true,
                    type: 'success',
                    onClick: () => openAction('activate-release', '激活发布', { release: row })
                  },
                  () => '激活'
                )
              : null,
            actions.includes('rollout')
              ? h(
                  NButton,
                  { text: true, onClick: () => openAction('rollout-release', '调整灰度', { release: row }) },
                  () => '灰度'
                )
              : null,
            actions.includes('resume')
              ? h(
                  NButton,
                  {
                    text: true,
                    type: 'info',
                    onClick: () => openAction('simple-release', '恢复发布', { release: row, releaseAction: 'resume' })
                  },
                  () => '恢复'
                )
              : actions.includes('pause')
                ? h(
                    NButton,
                    {
                      text: true,
                      type: 'warning',
                      onClick: () => openAction('simple-release', '暂停发布', { release: row, releaseAction: 'pause' })
                    },
                    () => '暂停'
                  )
                : null,
            canRollback.value
              ? h(
                  NButton,
                  {
                    text: true,
                    type: 'error',
                    onClick: () => openAction('create-rollback', '发起回滚审批', { release: row })
                  },
                  () => '发起回滚'
                )
              : null
          ])
        : '只读';
    }
  }
];

const rollbackStatusMeta: Record<
  RollbackRequest['status'],
  { label: string; type: 'default' | 'error' | 'info' | 'success' | 'warning' }
> = {
  approved: { label: '已批准', type: 'info' },
  cancelled: { label: '已取消', type: 'default' },
  executed: { label: '已执行', type: 'success' },
  rejected: { label: '已拒绝', type: 'error' },
  requested: { label: '待审批', type: 'warning' }
};

const rollbackColumns: DataTableColumns<RollbackRequest> = [
  { title: '发布 ID', key: 'releaseId', width: 110, render: row => short(row.releaseId) },
  { title: '目标版本', key: 'targetVersionId', width: 110, render: row => short(row.targetVersionId) },
  { title: '原因码', key: 'reasonCode', width: 140, render: row => h(NText, { code: true }, () => row.reasonCode) },
  {
    title: '状态',
    key: 'status',
    width: 100,
    render: row => {
      const meta = rollbackStatusMeta[row.status];
      return h(NTag, { bordered: false, type: meta.type }, () => meta.label);
    }
  },
  { title: '发起时间', key: 'createdAt', width: 170, render: row => date(row.createdAt) },
  { title: '审批时间', key: 'decidedAt', width: 170, render: row => date(row.decidedAt) },
  {
    title: '操作',
    key: 'actions',
    width: 240,
    render: row => {
      if (!canRollback.value) return '只读';
      const buttons: VNodeChild[] = [];
      if (row.status === 'requested') {
        buttons.push(
          h(NButton, { text: true, type: 'success', onClick: () => decideRollback(row, 'approve') }, () => '批准'),
          h(NButton, { text: true, type: 'error', onClick: () => decideRollback(row, 'reject') }, () => '拒绝')
        );
      }
      if (row.status === 'approved') {
        buttons.push(h(NButton, { text: true, type: 'error', onClick: () => executeRollback(row) }, () => '执行回滚'));
      }
      if (row.status === 'requested' || row.status === 'approved') {
        buttons.push(h(NButton, { text: true, onClick: () => cancelRollback(row) }, () => '取消'));
      }
      return buttons.length ? h(NSpace, { size: 8 }, () => buttons) : '—';
    }
  }
];

const auditColumns: DataTableColumns<OfficialAgentAuditEvent> = [
  { title: '时间', key: 'created_at', width: 170, render: row => date(row.created_at) },
  { title: '事件', key: 'event_type', minWidth: 160, ellipsis: { tooltip: true } },
  { title: '管理员', key: 'actor_admin_id', width: 150, render: row => row.actor_admin_id || '—' },
  { title: '角色', key: 'actor_admin_role', width: 120, render: row => row.actor_admin_role || '—' },
  { title: '对象类型', key: 'object_type', width: 120 },
  { title: '对象 ID', key: 'object_id', minWidth: 180, ellipsis: { tooltip: true } },
  { title: '结果', key: 'outcome', width: 90 },
  { title: '原因码', key: 'reason_code', width: 140, render: row => row.reason_code || '—' },
  { title: '请求 ID', key: 'request_id', minWidth: 160, ellipsis: { tooltip: true } }
];

onMounted(() => {
  if (canRead.value) void load();
});
</script>

<template>
  <div v-if="!canRead">
    <NAlert type="warning" :show-icon="false">当前角色无权查看官方 Agent 工作台。</NAlert>
  </div>
  <div v-else class="flex flex-col gap-16px">
    <NAlert v-if="state === 'ready' && workbenchState === 'empty'" type="info" :show-icon="false">
      Cloud 真实接口已连接，当前定义、草稿、审核、版本、发布和审计事件均返回 0 条；这里不会填充演示数据。
    </NAlert>
    <NAlert v-else-if="state === 'ready'" type="success" :show-icon="false">
      Cloud 官方 Agent 管理接口已连接，以下数量均来自真实 Cloud 数据。
    </NAlert>
    <NSpace justify="end">
      <NButton v-if="canDraft" type="primary" @click="openAction('create-definition', '新建官方 Agent 定义')">
        新建定义
      </NButton>
      <NButton v-if="canDraft" @click="openAction('create-draft', '新建草稿')">新建草稿</NButton>
      <NButton :loading="loading" @click="load">刷新</NButton>
    </NSpace>

    <ResourceState :state="state === 'ready' ? 'ready' : state">
      <template #actions><NButton @click="load">重试</NButton></template>
      <NTabs type="line" animated>
        <NTabPane name="definitions" :tab="`定义（${definitions.length}）`">
          <NDataTable
            :columns="definitionColumns"
            :data="definitions"
            :loading="loading"
            :row-key="row => row.definition_id"
            size="small"
            :scroll-x="880"
          />
        </NTabPane>
        <NTabPane name="drafts" :tab="`草稿（${drafts.length}）`">
          <NDataTable
            :columns="draftColumns"
            :data="drafts"
            :loading="loading"
            :row-key="row => row.draft_id"
            size="small"
            :scroll-x="980"
          />
        </NTabPane>
        <NTabPane name="submissions" :tab="`审核（${submissions.length}）`">
          <NDataTable
            :columns="submissionColumns"
            :data="submissions"
            :loading="loading"
            :row-key="row => row.submission_id"
            size="small"
            :scroll-x="980"
          />
        </NTabPane>
        <NTabPane name="releases" :tab="`发布（${releases.length}）`">
          <NDataTable
            :columns="releaseColumns"
            :data="releases"
            :loading="loading"
            :row-key="row => row.release_id"
            size="small"
            :scroll-x="1240"
          />
        </NTabPane>
        <NTabPane name="rollbacks" :tab="`回滚审批（${rollbacks.length}）`">
          <NAlert type="info" class="mb-12px" :show-icon="false">
            回滚采用双人复核：发起人创建审批，另一名管理员批准后由批准人执行（执行需 TOTP 二次验证）。
          </NAlert>
          <NDataTable
            :columns="rollbackColumns"
            :data="rollbacks"
            :loading="loading"
            :row-key="row => row.id"
            size="small"
            :scroll-x="1140"
          />
        </NTabPane>
        <NTabPane name="audit-events" :tab="`审计事件（${auditEvents.length}）`">
          <NDataTable
            :columns="auditColumns"
            :data="auditEvents"
            :loading="loading"
            :row-key="row => row.event_id"
            size="small"
            :scroll-x="1080"
          />
        </NTabPane>
      </NTabs>
    </ResourceState>

    <NModal v-model:show="showAction" preset="card" :title="actionTitle" class="w-720px max-w-[calc(100vw-32px)]">
      <NForm label-placement="top">
        <template v-if="actionKind === 'create-definition'">
          <NFormItem label="Agent 名称" required>
            <NInput v-model:value="definitionForm.display_name" />
          </NFormItem>
        </template>

        <template v-if="actionKind === 'create-draft' || actionKind === 'update-draft'">
          <NFormItem v-if="actionKind === 'create-draft'" label="所属定义" required>
            <NSelect
              v-model:value="draftForm.definition_id"
              :options="definitions.map(item => ({ label: item.display_name, value: item.definition_id }))"
            />
          </NFormItem>
          <NFormItem label="草稿类型" required>
            <NSelect
              v-model:value="draftForm.kind"
              :options="[
                { label: '全新 Agent', value: 'initial' },
                { label: '版本更新', value: 'next' }
              ]"
            />
          </NFormItem>
          <NFormItem v-if="draftForm.kind === 'next'" label="基础版本 ID" required>
            <NInput v-model:value="draftForm.baseVersionId" placeholder="当前线上 Agent 版本 UUID" />
          </NFormItem>
          <NFormItem label="显示名称" :required="actionKind === 'create-draft'">
            <NInput v-model:value="draftForm.display_name" />
          </NFormItem>
          <NFormItem label="Manifest（JSON）" required>
            <NInput v-model:value="draftForm.manifestJSON" type="textarea" :rows="6" class="font-mono" />
          </NFormItem>
          <NFormItem label="Bundle（JSON）" required>
            <NInput v-model:value="draftForm.bundleJSON" type="textarea" :rows="6" class="font-mono" />
          </NFormItem>
        </template>

        <template v-if="actionKind === 'review-submission'">
          <NFormItem label="审核结论" required>
            <NSelect
              v-model:value="reviewForm.decision"
              :options="[
                { label: '通过', value: 'approve' },
                { label: '驳回', value: 'reject' }
              ]"
            />
          </NFormItem>
          <NFormItem v-if="reviewForm.decision === 'approve'" label="首发渠道" required>
            <NSelect
              v-model:value="reviewForm.initial_channels"
              multiple
              :options="[
                { label: 'stable', value: 'stable' },
                { label: 'internal', value: 'internal' }
              ]"
            />
          </NFormItem>
          <NFormItem v-if="reviewForm.decision === 'reject'" label="审核原因码" required>
            <NInput v-model:value="reviewForm.review_reason_code" />
          </NFormItem>
          <NFormItem v-if="reviewForm.decision === 'reject'" label="审核说明（可选）">
            <NInput v-model:value="reviewForm.safe_note" type="textarea" :rows="2" />
          </NFormItem>
        </template>

        <template v-if="actionKind === 'activate-release' || actionKind === 'rollout-release'">
          <NFormItem v-if="actionKind === 'activate-release'" label="版本" required>
            <NSelect
              v-model:value="releaseForm.version_id"
              :options="
                versions.map(item => ({
                  label: `v${item.version_number}（${short(item.version_id)}）`,
                  value: item.version_id
                }))
              "
            />
          </NFormItem>
          <NFormItem label="灰度比例（基点，10000 = 100%）" required>
            <NInputNumber v-model:value="releaseForm.rollout_basis_points" :min="0" :max="10000" class="w-full" />
          </NFormItem>
          <NFormItem label="最低桌面版本" required>
            <NInput v-model:value="releaseForm.minimum_desktop_version" />
          </NFormItem>
        </template>

        <template v-if="actionKind === 'create-rollback'">
          <NFormItem label="回滚目标版本 ID" required>
            <NInput v-model:value="rollbackForm.target_version_id" placeholder="UUID" />
          </NFormItem>
          <NFormItem label="回滚目标发布修订 ID" required>
            <NInput v-model:value="rollbackForm.target_release_revision_id" placeholder="UUID" />
          </NFormItem>
        </template>

        <NFormItem label="原因码" required>
          <NInput v-model:value="reasonForm.reason_code" placeholder="如 routine_release、policy_violation" />
        </NFormItem>
        <NFormItem label="工单编号（可选）">
          <NInput v-model:value="reasonForm.ticket_reference" />
        </NFormItem>
      </NForm>
      <template #footer>
        <NSpace justify="end">
          <NButton @click="showAction = false">取消</NButton>
          <NButton type="primary" :loading="submitting" @click="performAction">确认提交</NButton>
        </NSpace>
      </template>
    </NModal>

    <StepUpDialog v-model:show="showStepUp" @verified="onStepUpVerified" @cancelled="onStepUpCancelled" />
  </div>
</template>
