import {
  PauseCircleOutlined,
  PlayCircleOutlined,
  ReloadOutlined,
  RollbackOutlined,
  SearchOutlined,
} from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ColumnsType } from 'antd/es/table';
import {
  Alert,
  Button,
  Card,
  Descriptions,
  Input,
  Modal,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import { useEffect, useRef, useState } from 'react';

import {
  APIError,
  decideOfficialRollback,
  getOfficialAudit,
  getOfficialReleases,
  getOfficialRollbacks,
  getOfficialVersions,
  newIdempotencyKey,
  postJSON,
  postOfficialMutation,
  requestOfficialRollback,
} from '../api/client';
import type {
  CloudUser,
  OfficialAuditEvent,
  OfficialOperation,
  OfficialRelease,
  OfficialRollbackApproval,
  OfficialVersion,
  ReasonInput,
} from '../api/contracts';
import { useAuth } from '../auth/AuthProvider';
import { StepUpModal } from '../auth/StepUpModal';
import { CloudBoundary } from '../components/CloudBoundary';
import { OperationStatus } from '../components/OperationStatus';
import { ReasonForm } from '../components/ReasonForm';

type ReleaseAction = 'activate' | 'rollout' | 'pause' | 'resume' | 'rollback';

interface ReleaseMutationInput {
  action: Exclude<ReleaseAction, 'rollback'>;
  release: OfficialRelease;
  reason: ReasonInput;
  idempotencyKey: string;
}

interface RollbackMutationInput {
  release: OfficialRelease;
  version: OfficialVersion;
  targetRevisionID: string;
  reason: ReasonInput;
  idempotencyKey: string;
}

function maskedIdentity(user: CloudUser): string {
  return user.masked_email ?? user.masked_phone ?? '已脱敏 Cloud 用户';
}

function releaseState(value: OfficialRelease['state']): React.ReactNode {
  return value === 'active' ? <Tag color="green">发布中</Tag> : <Tag color="orange">已暂停</Tag>;
}

function rollbackState(item: OfficialRollbackApproval): React.ReactNode {
  if (item.execution_status !== 'not_started') return <Tag color="processing">{item.execution_status}</Tag>;
  return <Tag>{item.approval_status}</Tag>;
}

export function OfficialAgentReleasesPage() {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const role = auth.session?.administrator.role;
  const operator = role === 'operator';
  const canAudit = role === 'auditor' || role === 'super_admin';
  const [selectedReleaseID, setSelectedReleaseID] = useState<string | null>(null);
  const [selectedVersionID, setSelectedVersionID] = useState<string | null>(null);
  const [rolloutPercentOverride, setRolloutPercentOverride] = useState<string | null>(null);
  const [minimumVersionOverride, setMinimumVersionOverride] = useState<string | null>(null);
  const [lookupValue, setLookupValue] = useState('');
  const [lookupMessage, setLookupMessage] = useState<string | null>(null);
  const [audience, setAudience] = useState<CloudUser[]>([]);
  const lookupInput = useRef<{ type: 'email' | 'phone'; value: string } | null>(null);
  const [action, setAction] = useState<ReleaseAction | null>(null);
  const [rollbackRevisionIDOverride, setRollbackRevisionIDOverride] = useState<string | null>(null);
  const [operation, setOperation] = useState<OfficialOperation | null>(null);
  const [rollbackApproval, setRollbackApproval] = useState<OfficialRollbackApproval | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [stepUpOpen, setStepUpOpen] = useState(false);
  const retryAfterStepUp = useRef<(() => Promise<void>) | null>(null);

  const versions = useQuery({
    queryKey: ['official-versions'],
    queryFn: () => getOfficialVersions(new URLSearchParams({ limit: '100' })),
    retry: false,
  });
  const releases = useQuery({
    queryKey: ['official-releases'],
    queryFn: () => getOfficialReleases(new URLSearchParams({ limit: '50' })),
    retry: false,
  });
  const rollbacks = useQuery({
    queryKey: ['official-rollbacks', operator ? 'mine' : 'all'],
    queryFn: () => getOfficialRollbacks(new URLSearchParams({ view: operator ? 'mine' : 'all', limit: '50' })),
    enabled: operator || canAudit,
    retry: false,
    refetchInterval: (query) => query.state.data?.items.some((item) =>
      ['queued', 'executing', 'reconciling'].includes(item.execution_status)) ? 2_000 : false,
  });
  const audit = useQuery({
    queryKey: ['official-audit'],
    queryFn: () => getOfficialAudit(new URLSearchParams({ limit: '50' })),
    enabled: canAudit,
    retry: false,
  });

  const releaseItems = releases.data?.items ?? [];
  const versionItems = versions.data?.items ?? [];
  const selectedRelease = releaseItems.find((item) => item.release_id === selectedReleaseID) ?? releaseItems[0];
  const compatibleVersions = versionItems.filter((item) => item.definition_id === selectedRelease?.definition_id);
  const selectedVersion = compatibleVersions.find((item) => item.version_id === selectedVersionID)
    ?? compatibleVersions.find((item) => item.version_id === selectedRelease?.agent_version_id)
    ?? compatibleVersions[0];
  const rolloutPercent = rolloutPercentOverride ?? (selectedRelease ? String(selectedRelease.rollout_basis_points / 100) : '');
  const minimumVersion = minimumVersionOverride ?? selectedRelease?.minimum_desktop_version ?? '';
  const rollbackRevisionID = rollbackRevisionIDOverride ?? selectedRelease?.previous_revision_id ?? '';

  useEffect(
    () => () => {
      if (lookupInput.current) lookupInput.current.value = '';
      lookupInput.current = null;
    },
    [],
  );

  const lookup = useMutation({
    mutationFn: (input: { type: 'email' | 'phone'; value: string }) => postJSON<CloudUser>('/cloud-users/lookup', input),
    onSuccess: (user) => {
      setAudience((current) => current.some((item) => item.user_id === user.user_id) ? current : [...current, user]);
      setLookupMessage(`已加入：${maskedIdentity(user)}。完整身份未保存到页面或 URL。`);
    },
    onError: (cause) => setLookupMessage(cause instanceof APIError ? cause.message : '精确查找暂时不可用'),
    onSettled: (_result, _error, variables) => {
      setLookupValue('');
      variables.value = '';
      if (lookupInput.current === variables) lookupInput.current = null;
    },
  });

  const submitLookup = () => {
    const value = lookupValue.trim();
    const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
    const phone = /^\+?[0-9][0-9 -]{6,20}$/.test(value);
    if (!email && !phone) {
      setLookupMessage('请输入完整且有效的邮箱或手机号');
      return;
    }
    const input = { type: email ? 'email' as const : 'phone' as const, value };
    setLookupValue('');
    setLookupMessage(null);
    lookupInput.current = input;
    lookup.mutate(input);
  };

  const mutationError = (cause: unknown, retry: () => Promise<void>) => {
    if (cause instanceof APIError && cause.code === 'STEP_UP_REQUIRED') {
      retryAfterStepUp.current = retry;
      setStepUpOpen(true);
      return;
    }
    if (cause instanceof APIError && (cause.code === 'STATE_CONFLICT' || cause.code === 'TARGET_DIGEST_MISMATCH')) {
      setMessage('发布头或目标版本已变化，已刷新 Cloud 状态；本次操作没有执行。');
      void queryClient.invalidateQueries({ queryKey: ['official-releases'] });
      void queryClient.invalidateQueries({ queryKey: ['official-versions'] });
      return;
    }
    setMessage(cause instanceof Error ? cause.message : '发布操作未能排队');
  };

  const releaseMutation = useMutation({
    mutationFn: (input: ReleaseMutationInput) => {
      const version = input.action === 'activate'
        ? selectedVersion
        : versionItems.find((item) => item.version_id === input.release.agent_version_id);
      if (!version) throw new Error('找不到发布所绑定的不可变版本');
      const percent = Number(rolloutPercent);
      const basisPoints = Math.round(percent * 100);
      if (!Number.isFinite(percent) || percent < 0 || percent > 100 || basisPoints !== percent * 100) {
        throw new Error('灰度百分比必须在 0–100 之间，最多两位小数');
      }
      if (!/^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(minimumVersion.trim())) {
        throw new Error('最低桌面版本必须是 SemVer，例如 v0.18.0');
      }
      const payload = input.action === 'activate'
        ? {
            version_id: version.version_id,
            rollout_basis_points: basisPoints,
            minimum_desktop_version: minimumVersion.trim(),
            allowlisted_user_ids: audience.map((item) => item.user_id),
          }
        : input.action === 'rollout'
          ? {
              rollout_basis_points: basisPoints,
              minimum_desktop_version: minimumVersion.trim(),
              allowlisted_user_ids: audience.map((item) => item.user_id),
            }
          : {};
      return postOfficialMutation(
        `/official-agent-releases/${input.release.release_id}/${input.action}`,
        {
          expected_revision: input.release.head_revision,
          expected_target_digest: version.content_digest,
          reason_code: input.reason.reason_code,
          ticket_reference: input.reason.ticket_reference,
          note: input.reason.note,
          payload,
        },
        input.idempotencyKey,
      );
    },
    onSuccess: (result) => {
      setOperation(result);
      setAction(null);
      setRolloutPercentOverride(null);
      setMinimumVersionOverride(null);
      setAudience([]);
      setStepUpOpen(false);
      retryAfterStepUp.current = null;
      setMessage('发布变更已进入队列；只有 Cloud 返回 succeeded 才代表真实生效。');
      void queryClient.invalidateQueries({ queryKey: ['official-releases'] });
    },
  });

  const rollbackMutation = useMutation({
    mutationFn: (input: RollbackMutationInput) => requestOfficialRollback(
      input.release.release_id,
      {
        target_version_id: input.version.version_id,
        target_release_revision_id: input.targetRevisionID,
        expected_head_revision: input.release.head_revision,
        target_digest: input.version.content_digest,
        reason_code: input.reason.reason_code,
        ticket_reference: input.reason.ticket_reference,
        note: input.reason.note,
      },
      input.idempotencyKey,
    ),
    onSuccess: (result) => {
      setRollbackApproval(result);
      setAction(null);
      setStepUpOpen(false);
      retryAfterStepUp.current = null;
      setMessage('回滚申请已创建，等待另一名 Super Admin 审批；当前发布尚未改变。');
      void queryClient.invalidateQueries({ queryKey: ['official-rollbacks'] });
    },
  });

  const executeRelease = async (input: ReleaseMutationInput) => {
    const retry = () => executeRelease(input);
    try {
      await releaseMutation.mutateAsync(input);
    } catch (cause) {
      mutationError(cause, retry);
    }
  };

  const executeRollback = async (input: RollbackMutationInput) => {
    const retry = () => executeRollback(input);
    try {
      await rollbackMutation.mutateAsync(input);
    } catch (cause) {
      mutationError(cause, retry);
    }
  };

  const cancelRollback = useMutation({
    mutationFn: (item: OfficialRollbackApproval) => decideOfficialRollback(item.id, 'cancel', newIdempotencyKey()),
    onSuccess: () => {
      setMessage('回滚申请已取消，当前发布未改变。');
      void queryClient.invalidateQueries({ queryKey: ['official-rollbacks'] });
    },
    onError: (cause) => setMessage(cause instanceof APIError ? cause.message : '回滚申请未能取消'),
  });

  const unavailable = versions.error ?? releases.error ?? rollbacks.error ?? audit.error;
  const auditColumns: ColumnsType<OfficialAuditEvent> = [
    { title: '时间', dataIndex: 'created_at', width: 190 },
    { title: '事件', dataIndex: 'event_type' },
    { title: '对象', dataIndex: 'object_type', width: 160 },
    { title: '结果', dataIndex: 'outcome', width: 120 },
    { title: '角色', dataIndex: 'actor_admin_role', width: 120 },
  ];

  return (
    <div className="official-agent-releases-page">
      <div className="page-heading">
        <div>
          <Typography.Title level={3}>官方 Agent 发布</Typography.Title>
          <Typography.Paragraph type="secondary">管理已审核不可变版本的灰度、暂停与双人回滚；不接触用户运行数据。</Typography.Paragraph>
        </div>
        <Button icon={<ReloadOutlined aria-hidden />} onClick={() => {
          void versions.refetch();
          void releases.refetch();
          if (rollbacks.isEnabled) void rollbacks.refetch();
          if (audit.isEnabled) void audit.refetch();
        }}>刷新 Cloud 状态</Button>
      </div>
      <Alert
        className="page-alert"
        type="info"
        showIcon
        message="版本更新只影响新安装和新会话"
        description="已运行会话的 RuntimeBinding 不改变；Memory、会话、文件、私有 Skill 与 Hermes 本地学习数据不会上传。"
      />
      {message && <Alert className="page-alert" type="warning" showIcon message={message} />}
      {operation && <Card size="small"><Space>最近发布操作 <OperationStatus state={operation.state} /></Space></Card>}
      {rollbackApproval && (
        <Alert
          className="page-alert"
          type="info"
          showIcon
          message={`回滚审批：${rollbackApproval.approval_status}`}
          description={`执行状态：${rollbackApproval.execution_status}`}
        />
      )}

      <CloudBoundary error={unavailable} empty={releases.isSuccess && releaseItems.length === 0} onRetry={() => {
        void versions.refetch();
        void releases.refetch();
      }}>
        <Card className="data-card" title="发布通道">
          <Space direction="vertical" size={16} style={{ width: '100%' }}>
            <Select
              aria-label="发布通道"
              style={{ width: '100%' }}
              value={selectedRelease?.release_id}
              options={releaseItems.map((item) => ({
                value: item.release_id,
                label: `${item.channel} · ${item.definition_id}`,
              }))}
              onChange={(value) => {
                setSelectedReleaseID(value);
                setSelectedVersionID(null);
                setRolloutPercentOverride(null);
                setMinimumVersionOverride(null);
                setRollbackRevisionIDOverride(null);
                setAudience([]);
              }}
            />
            {selectedRelease && (
              <Descriptions bordered size="small" column={2}>
                <Descriptions.Item label="通道">{selectedRelease.channel}</Descriptions.Item>
                <Descriptions.Item label="状态">{releaseState(selectedRelease.state)}</Descriptions.Item>
                <Descriptions.Item label="发布头修订">{selectedRelease.head_revision}</Descriptions.Item>
                <Descriptions.Item label="当前受众数">{selectedRelease.audience_count}</Descriptions.Item>
                <Descriptions.Item label="当前版本" span={2}>{selectedRelease.agent_version_id}</Descriptions.Item>
              </Descriptions>
            )}

            {operator && selectedRelease && (
              <>
                <label htmlFor="official-release-version">已审核不可变版本</label>
                <Select
                  id="official-release-version"
                  aria-label="已审核不可变版本"
                  value={selectedVersion?.version_id}
                  options={compatibleVersions.map((item) => ({
                    value: item.version_id,
                    label: `v${item.version_number} · ${item.content_digest.slice(0, 12)}`,
                  }))}
                  onChange={setSelectedVersionID}
                />
                <label htmlFor="official-rollout-percent">灰度百分比</label>
                <Input
                  id="official-rollout-percent"
                  aria-label="灰度百分比"
                  inputMode="decimal"
                  value={rolloutPercent}
                  onChange={(event) => setRolloutPercentOverride(event.target.value)}
                />
                <label htmlFor="official-minimum-version">最低桌面版本</label>
                <Input
                  id="official-minimum-version"
                  aria-label="最低桌面版本"
                  value={minimumVersion}
                  maxLength={64}
                  onChange={(event) => setMinimumVersionOverride(event.target.value)}
                />
                <label htmlFor="official-audience-lookup">精确查找灰度账号</label>
                <Space.Compact block>
                  <Input
                    id="official-audience-lookup"
                    aria-label="精确查找灰度账号"
                    value={lookupValue}
                    autoComplete="off"
                    maxLength={320}
                    placeholder="完整邮箱或手机号，仅用于一次性精确查找"
                    onChange={(event) => {
                      setLookupValue(event.target.value);
                      setLookupMessage(null);
                    }}
                    onPressEnter={submitLookup}
                  />
                  <Button icon={<SearchOutlined aria-hidden />} loading={lookup.isPending} onClick={submitLookup}>加入灰度</Button>
                </Space.Compact>
                {lookupMessage && <Typography.Text type="secondary">{lookupMessage}</Typography.Text>}
                <Space wrap>
                  {audience.map((item) => (
                    <Tag
                      key={item.user_id}
                      closable
                      onClose={() => setAudience((current) => current.filter((candidate) => candidate.user_id !== item.user_id))}
                    >{maskedIdentity(item)}</Tag>
                  ))}
                  <Typography.Text type="secondary">本次提交的定向账号：{audience.length}</Typography.Text>
                </Space>
                {selectedRelease.audience_count > 0 && audience.length === 0 && (
                  <Alert
                    type="warning"
                    showIcon
                    message="Cloud 不返回完整灰度名单"
                    description="为防止身份泄露，本次更新若不重新精确加入账号，将把定向名单改为空；当前页面只显示数量。"
                  />
                )}
                <Space wrap>
                  <Button type="primary" onClick={() => setAction('rollout')}>更新灰度</Button>
                  {selectedVersion?.version_id !== selectedRelease.agent_version_id && (
                    <Button icon={<PlayCircleOutlined aria-hidden />} onClick={() => setAction('activate')}>启用所选版本</Button>
                  )}
                  {selectedRelease.state === 'active'
                    ? <Button icon={<PauseCircleOutlined aria-hidden />} onClick={() => setAction('pause')}>暂停发布</Button>
                    : <Button icon={<PlayCircleOutlined aria-hidden />} onClick={() => setAction('resume')}>恢复发布</Button>}
                  <Button danger icon={<RollbackOutlined aria-hidden />} onClick={() => setAction('rollback')}>申请回滚</Button>
                </Space>
              </>
            )}
          </Space>
        </Card>

        {(operator || canAudit) && (
          <Card className="data-card" title={operator ? '我的回滚申请' : '回滚审批历史'} style={{ marginTop: 16 }}>
            <Table
              rowKey="id"
              pagination={false}
              dataSource={rollbacks.data?.items ?? []}
              columns={[
                { title: '发布 ID', dataIndex: 'release_id' },
                { title: '目标版本', dataIndex: 'target_version_id' },
                { title: '状态', render: (_, item: OfficialRollbackApproval) => rollbackState(item) },
                ...(operator ? [{
                  title: '操作',
                  render: (_: unknown, item: OfficialRollbackApproval) => (
                    <Button
                      danger
                      disabled={item.approval_status !== 'pending_review'}
                      onClick={() => cancelRollback.mutate(item)}
                    >取消申请</Button>
                  ),
                }] : []),
              ]}
            />
          </Card>
        )}

        {canAudit && (
          <Card className="data-card" title="官方 Agent 审计" style={{ marginTop: 16 }}>
            <Table rowKey="event_id" pagination={false} dataSource={audit.data?.items ?? []} columns={auditColumns} />
          </Card>
        )}
      </CloudBoundary>

      <Modal
        title={action === 'rollback' ? '申请双人回滚' : '确认发布变更'}
        open={Boolean(action && selectedRelease)}
        footer={null}
        destroyOnHidden
        onCancel={() => setAction(null)}
      >
        {action === 'rollback' && (
          <>
            <Alert
              className="page-alert"
              type="warning"
              showIcon
              message="回滚不会立即执行"
              description="必须选择与旧发布修订相符的不可变版本，并由另一名 Super Admin 审批；Cloud 会再次校验版本摘要和发布头。"
            />
            <label htmlFor="official-rollback-version">目标不可变版本</label>
            <Select
              id="official-rollback-version"
              aria-label="目标不可变版本"
              style={{ width: '100%', marginBottom: 12 }}
              value={selectedVersion?.version_id}
              options={compatibleVersions.map((item) => ({ value: item.version_id, label: `v${item.version_number} · ${item.content_digest.slice(0, 12)}` }))}
              onChange={setSelectedVersionID}
            />
            <label htmlFor="official-rollback-revision">目标发布修订 ID</label>
            <Input
              id="official-rollback-revision"
              aria-label="目标发布修订 ID"
              value={rollbackRevisionID}
              autoComplete="off"
              onChange={(event) => setRollbackRevisionIDOverride(event.target.value.trim())}
            />
          </>
        )}
        {action && selectedRelease && (
          <ReasonForm
            usage="official_agent"
            submitLabel={action === 'rollback' ? '提交回滚审批' : '排队发布变更'}
            pending={releaseMutation.isPending || rollbackMutation.isPending}
            onSubmit={async (reason) => {
              if (action === 'rollback') {
                if (!selectedVersion || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(rollbackRevisionID)) {
                  setMessage('请选择目标不可变版本并填写有效的旧发布修订 ID。');
                  return;
                }
                await executeRollback({
                  release: selectedRelease,
                  version: selectedVersion,
                  targetRevisionID: rollbackRevisionID,
                  reason,
                  idempotencyKey: newIdempotencyKey(),
                });
                return;
              }
              await executeRelease({
                action,
                release: selectedRelease,
                reason,
                idempotencyKey: newIdempotencyKey(),
              });
            }}
          />
        )}
      </Modal>

      <StepUpModal
        open={stepUpOpen}
        onCancel={() => {
          setStepUpOpen(false);
          retryAfterStepUp.current = null;
        }}
        onVerified={async () => {
          if (retryAfterStepUp.current) await retryAfterStepUp.current();
        }}
      />
    </div>
  );
}
