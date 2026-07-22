import {
  EditOutlined,
  PlusOutlined,
  SafetyCertificateOutlined,
} from '@ant-design/icons';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ColumnsType } from 'antd/es/table';
import {
  Alert,
  Button,
  Card,
  Col,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Row,
  Select,
  Space,
  Spin,
  Switch,
  Table,
  Tag,
  Typography,
} from 'antd';
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { APIError, newIdempotencyKey } from '../api/client';
import {
  createReasonCode,
  getSecurityPolicy,
  listReasonCodes,
  updateReasonCode,
  updateSecurityPolicy,
  useReasonCodes,
} from '../api/settings';
import {
  hasPermission,
  type ReasonCategory,
  type ReasonCode,
  type SecurityPolicy,
} from '../api/contracts';
import { useAuth } from '../auth/AuthProvider';
import { StepUpModal } from '../auth/StepUpModal';

interface PolicyDraft {
  idle: number;
  absolute: number;
  retention: number;
  reasonCode: string;
  ticketReference: string;
  note: string;
}

interface PolicyDraftState {
  revision: number;
  draft: PolicyDraft;
}

interface CreateReasonDraft {
  code: string;
  category: ReasonCategory;
  label: string;
  reasonCode: string;
  ticketReference: string;
  note: string;
}

interface UpdateReasonDraft {
  label: string;
  active: boolean;
  reasonCode: string;
  ticketReference: string;
  note: string;
}

const emptyPolicyDraft: PolicyDraft = {
  idle: 30,
  absolute: 12,
  retention: 730,
  reasonCode: '',
  ticketReference: '',
  note: '',
};

const emptyCreateDraft: CreateReasonDraft = {
  code: '',
  category: 'administrator',
  label: '',
  reasonCode: '',
  ticketReference: '',
  note: '',
};

const emptyUpdateDraft: UpdateReasonDraft = {
  label: '',
  active: true,
  reasonCode: '',
  ticketReference: '',
  note: '',
};

const categoryLabels: Record<ReasonCategory, string> = {
  administrator: '管理员',
  session: '会话',
  device: '设备',
  account: '账号',
  security: '安全',
  official_agent: '官方 Agent',
};

const categoryOptions = (Object.entries(categoryLabels) as Array<[ReasonCategory, string]>).map(
  ([value, label]) => ({ value, label }),
);

const codePattern = /^[a-z][a-z0-9_]{2,63}$/;
const ticketPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const sensitiveText =
  /(?:[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|(?:\+?86[- ]?)?1[3-9]\d{9}|bearer\s+\S+|(?:password|secret|token|cookie)\s*[:=]\s*\S{6,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|-----BEGIN [A-Z ]*PRIVATE KEY-----)/iu;

function displayTime(raw: string): string {
  const value = new Date(raw);
  if (Number.isNaN(value.getTime())) return '—';
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(value);
}

function errorMessage(error: unknown): string {
  return error instanceof APIError ? error.message : '请求未能完成，请稍后重试';
}

function validMutationMetadata(ticketReference: string, note: string): boolean {
  const ticket = ticketReference.trim();
  const normalizedNote = note.trim();
  return (ticket === '' || ticketPattern.test(ticket)) && normalizedNote.length <= 500 &&
    !sensitiveText.test(ticket) && !sensitiveText.test(normalizedNote);
}

export function SystemSettingsPage() {
  const auth = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const role = auth.session?.administrator.role;
  const canManage = Boolean(role && hasPermission(role, 'system_settings.manage'));
  const [policyDraftState, setPolicyDraftState] = useState<PolicyDraftState | null>(null);
  const [createDraft, setCreateDraft] = useState<CreateReasonDraft>(emptyCreateDraft);
  const [updateDraft, setUpdateDraft] = useState<UpdateReasonDraft>(emptyUpdateDraft);
  const [createOpen, setCreateOpen] = useState(false);
  const [selectedReason, setSelectedReason] = useState<ReasonCode | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [pageError, setPageError] = useState<string | null>(null);
  const [pageSuccess, setPageSuccess] = useState<string | null>(null);
  const [stepUpOpen, setStepUpOpen] = useState(false);
  const [pendingAfterStepUp, setPendingAfterStepUp] = useState<(() => Promise<void>) | null>(null);

  const policyQuery = useQuery({
    queryKey: ['system-settings'],
    queryFn: getSecurityPolicy,
    enabled: Boolean(auth.session),
    retry: false,
  });
  const catalogQuery = useQuery({
    queryKey: ['reason-codes', 'catalog'],
    queryFn: () => listReasonCodes({ includeInactive: true }),
    enabled: Boolean(auth.session),
    retry: false,
  });
  const mutationReasons = useReasonCodes('settings', canManage);
  const activeMutationReasons = (mutationReasons.data?.items ?? []).filter((reason) => reason.active);
  const mutationReasonOptions = activeMutationReasons.map((reason) => ({ value: reason.code, label: reason.label }));

  const serverPolicyDraft = policyQuery.data ? {
    idle: policyQuery.data.session_idle_minutes,
    absolute: policyQuery.data.session_absolute_hours,
    retention: policyQuery.data.audit_retention_days,
    reasonCode: '',
    ticketReference: '',
    note: '',
  } : emptyPolicyDraft;
  const policyDraft = policyDraftState && policyQuery.data && policyDraftState.revision === policyQuery.data.revision
    ? policyDraftState.draft
    : serverPolicyDraft;
  const changePolicyDraft = (update: (draft: PolicyDraft) => PolicyDraft) => {
    const revision = policyQuery.data?.revision;
    if (!revision) return;
    setPolicyDraftState({ revision, draft: update(policyDraft) });
  };

  const refreshSettings = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['system-settings'] }),
      queryClient.invalidateQueries({ queryKey: ['reason-codes'] }),
    ]);
  };

  const handleMutationError = async (error: unknown) => {
    setPageSuccess(null);
    if (error instanceof APIError && error.code === 'SETTINGS_REVISION_CONFLICT') {
      await refreshSettings();
      setPageError('设置版本已变化，已刷新最新策略和原因目录');
      return;
    }
    setPageError(errorMessage(error));
  };

  const runProtected = async (operation: () => Promise<void>) => {
    if (submitting) return;
    setSubmitting(true);
    setPageError(null);
    setPageSuccess(null);
    try {
      await operation();
      setSubmitting(false);
    } catch (error) {
      if (error instanceof APIError && error.code === 'STEP_UP_REQUIRED') {
        setPendingAfterStepUp(() => operation);
        setStepUpOpen(true);
        return;
      }
      await handleMutationError(error);
      setSubmitting(false);
    }
  };

  const retryAfterStepUp = async () => {
    const operation = pendingAfterStepUp;
    if (!operation) {
      setSubmitting(false);
      setStepUpOpen(false);
      return;
    }
    try {
      await operation();
    } catch (error) {
      await handleMutationError(error);
    } finally {
      setSubmitting(false);
      setStepUpOpen(false);
      setPendingAfterStepUp(null);
    }
  };

  const savePolicy = async () => {
    const current = policyQuery.data;
    if (!current || !policyValid(policyDraft, activeMutationReasons)) {
      setPageError('请检查策略范围并选择有效的策略变更原因');
      return;
    }
    const idempotencyKey = newIdempotencyKey();
    const operation = async () => {
      const result = await updateSecurityPolicy({
        expected_revision: current.revision,
        session_idle_minutes: policyDraft.idle,
        session_absolute_hours: policyDraft.absolute,
        audit_retention_days: policyDraft.retention,
        reason_code: policyDraft.reasonCode,
        ticket_reference: policyDraft.ticketReference.trim(),
        note: policyDraft.note.trim(),
      }, idempotencyKey);
      queryClient.setQueryData<SecurityPolicy>(['system-settings'], result.policy);
      if (result.sessions_revoked) {
        await auth.clearSession();
        navigate('/login', { replace: true });
        return;
      }
      setPolicyDraftState({
        revision: result.policy.revision,
        draft: {
          idle: result.policy.session_idle_minutes,
          absolute: result.policy.session_absolute_hours,
          retention: result.policy.audit_retention_days,
          reasonCode: policyDraft.reasonCode,
          ticketReference: '',
          note: '',
        },
      });
      setPageSuccess('安全策略已更新');
    };
    await runProtected(operation);
  };

  const submitCreateReason = async () => {
    const revision = catalogQuery.data?.settings_revision;
    if (!revision || !reasonCreateValid(createDraft, activeMutationReasons)) {
      setPageError('请检查原因码、分类、名称和目录变更原因');
      return;
    }
    const idempotencyKey = newIdempotencyKey();
    const operation = async () => {
      await createReasonCode({
        code: createDraft.code,
        category: createDraft.category,
        label: createDraft.label.trim(),
        expected_settings_revision: revision,
        reason_code: createDraft.reasonCode,
        ticket_reference: createDraft.ticketReference.trim(),
        note: createDraft.note.trim(),
      }, idempotencyKey);
      setCreateOpen(false);
      setCreateDraft(emptyCreateDraft);
      setPageSuccess('标准原因码已创建');
      await refreshSettings();
    };
    await runProtected(operation);
  };

  const submitUpdateReason = async () => {
    const revision = catalogQuery.data?.settings_revision;
    const target = selectedReason;
    if (!revision || !target || !reasonUpdateValid(updateDraft, activeMutationReasons)) {
      setPageError('请检查显示名称、有效状态和目录变更原因');
      return;
    }
    const idempotencyKey = newIdempotencyKey();
    const operation = async () => {
      await updateReasonCode(target.code, {
        expected_settings_revision: revision,
        expected_reason_revision: target.revision,
        label: updateDraft.label.trim(),
        active: updateDraft.active,
        reason_code: updateDraft.reasonCode,
        ticket_reference: updateDraft.ticketReference.trim(),
        note: updateDraft.note.trim(),
      }, idempotencyKey);
      setSelectedReason(null);
      setUpdateDraft(emptyUpdateDraft);
      setPageSuccess('标准原因码已更新');
      await refreshSettings();
    };
    await runProtected(operation);
  };

  const columns = useMemo<ColumnsType<ReasonCode>>(() => [
    {
      title: '原因码',
      key: 'reason',
      render: (_, reason) => (
        <div className="table-primary-cell">
          <strong>{reason.label}</strong>
          <span>{reason.code}</span>
        </div>
      ),
    },
    { title: '分类', dataIndex: 'category', width: 120, render: (value: ReasonCategory) => categoryLabels[value] },
    {
      title: '状态', dataIndex: 'active', width: 110,
      render: (active: boolean) => <Tag color={active ? 'green' : 'default'}>{active ? '有效' : '已停用'}</Tag>,
    },
    { title: '修订号', dataIndex: 'revision', width: 100, align: 'center' },
    { title: '更新时间', dataIndex: 'updated_at', width: 180, render: displayTime },
    ...(canManage ? [{
      title: '操作', key: 'action', width: 100,
      render: (_: unknown, reason: ReasonCode) => (
        <Button
          type="link"
          icon={<EditOutlined />}
          aria-label={`编辑 ${reason.code}`}
          disabled={submitting}
          onClick={() => {
            setSelectedReason(reason);
            setUpdateDraft({ ...emptyUpdateDraft, label: reason.label, active: reason.active });
            setPageError(null);
          }}
        >编辑</Button>
      ),
    }] : []),
  ], [canManage, submitting]);

  const loading = policyQuery.isPending || catalogQuery.isPending;
  const loadError = policyQuery.error ?? catalogQuery.error;

  return (
    <div className="system-settings-page">
      <div className="page-heading">
        <div>
          <Typography.Title level={3}>系统安全设置</Typography.Title>
          <Typography.Paragraph type="secondary">
            管理管理员会话策略、审计保留期限和所有高风险操作使用的标准原因目录。
          </Typography.Paragraph>
        </div>
        <Tag icon={<SafetyCertificateOutlined />} color={canManage ? 'blue' : 'default'}>
          {canManage ? '超级管理员管理' : '只读模式'}
        </Tag>
      </div>

      {pageError && <Alert className="page-alert" type="error" showIcon message={pageError} closable onClose={() => setPageError(null)} />}
      {pageSuccess && <Alert className="page-alert" type="success" showIcon message={pageSuccess} closable onClose={() => setPageSuccess(null)} />}
      {loading && <div className="health-loading"><Spin size="large" /></div>}
      {loadError && (
        <Empty description={errorMessage(loadError)}>
          <Button onClick={() => void refreshSettings()}>重新加载</Button>
        </Empty>
      )}

      {policyQuery.data && (
        <Card
          className="data-card settings-policy-card"
          title="会话与审计策略"
          extra={<Typography.Text type="secondary">设置修订号：{policyQuery.data.revision}</Typography.Text>}
        >
          <Alert
            className="page-alert"
            type="info"
            showIcon
            message="修改保留期限不会立即删除或归档现有审计记录"
            description="该数值是部署与合规操作必须执行的最低保留策略；管理端保持审计记录只追加且不提供删除入口。"
          />
          {canManage && (
            <Alert
              className="page-alert"
              type="warning"
              showIcon
              message="会话时长变更会撤销全部管理员会话"
              description="包含当前操作人员；保存成功后需要重新登录。仅调整审计保留期限不会撤销会话。"
            />
          )}
          <Form layout="vertical" requiredMark={false}>
            <Row gutter={16}>
              <Col xs={24} md={8}>
                <Form.Item label="会话空闲超时（分钟）">
                  <InputNumber
                    aria-label="会话空闲超时（分钟）"
                    min={5}
                    max={120}
                    value={policyDraft.idle}
                    disabled={!canManage}
                    onChange={(value) => changePolicyDraft((draft) => ({ ...draft, idle: Number(value ?? 0) }))}
                  />
                </Form.Item>
              </Col>
              <Col xs={24} md={8}>
                <Form.Item label="会话绝对有效期（小时）">
                  <InputNumber
                    aria-label="会话绝对有效期（小时）"
                    min={1}
                    max={24}
                    value={policyDraft.absolute}
                    disabled={!canManage}
                    onChange={(value) => changePolicyDraft((draft) => ({ ...draft, absolute: Number(value ?? 0) }))}
                  />
                </Form.Item>
              </Col>
              <Col xs={24} md={8}>
                <Form.Item label="审计保留期限（天）">
                  <InputNumber
                    aria-label="审计保留期限（天）"
                    min={365}
                    max={3650}
                    value={policyDraft.retention}
                    disabled={!canManage}
                    onChange={(value) => changePolicyDraft((draft) => ({ ...draft, retention: Number(value ?? 0) }))}
                  />
                </Form.Item>
              </Col>
            </Row>
            {canManage && (
              <>
                {mutationReasons.isError && <Alert type="error" showIcon message="策略变更原因暂时不可用，保存已禁止" />}
                <Row gutter={16}>
                  <Col xs={24} md={8}>
                    <Form.Item label="策略变更原因">
                      <Select
                        aria-label="策略变更原因"
                        value={policyDraft.reasonCode || undefined}
                        loading={mutationReasons.isPending}
                        disabled={mutationReasons.isPending || mutationReasons.isError || activeMutationReasons.length === 0}
                        virtual={false}
                        options={mutationReasonOptions}
                        onChange={(value) => changePolicyDraft((draft) => ({ ...draft, reasonCode: value }))}
                      />
                    </Form.Item>
                  </Col>
                  <Col xs={24} md={8}>
                    <Form.Item label="工单编号">
                      <Input aria-label="策略工单编号" value={policyDraft.ticketReference} maxLength={128} onChange={(event) => changePolicyDraft((draft) => ({ ...draft, ticketReference: event.target.value }))} />
                    </Form.Item>
                  </Col>
                  <Col xs={24} md={8}>
                    <Form.Item label="补充说明">
                      <Input aria-label="策略补充说明" value={policyDraft.note} maxLength={500} onChange={(event) => changePolicyDraft((draft) => ({ ...draft, note: event.target.value }))} />
                    </Form.Item>
                  </Col>
                </Row>
                <Button
                  type="primary"
                  loading={submitting}
                  disabled={submitting || mutationReasons.isPending || mutationReasons.isError || activeMutationReasons.length === 0}
                  onClick={() => void savePolicy()}
                >保存安全策略</Button>
              </>
            )}
          </Form>
          <Typography.Paragraph type="secondary" className="settings-updated-at">
            最近更新：{displayTime(policyQuery.data.updated_at)}
          </Typography.Paragraph>
        </Card>
      )}

      {catalogQuery.data && (
        <Card
          className="data-card"
          title="标准原因目录"
          extra={canManage ? (
            <Button type="primary" icon={<PlusOutlined />} disabled={submitting} onClick={() => {
              setCreateDraft(emptyCreateDraft);
              setCreateOpen(true);
              setPageError(null);
            }}>新增原因码</Button>
          ) : <Typography.Text type="secondary">目录修订号：{catalogQuery.data.settings_revision}</Typography.Text>}
        >
          <Table rowKey="code" dataSource={catalogQuery.data.items} columns={columns} pagination={false} scroll={{ x: 900 }} />
        </Card>
      )}

      <ReasonCreateModal
        open={createOpen}
        draft={createDraft}
        submitting={submitting}
        reasonOptions={mutationReasonOptions}
        reasonsUnavailable={mutationReasons.isPending || mutationReasons.isError || activeMutationReasons.length === 0}
        onChange={setCreateDraft}
        onCancel={() => !submitting && setCreateOpen(false)}
        onSubmit={() => void submitCreateReason()}
      />
      <ReasonUpdateModal
        target={selectedReason}
        draft={updateDraft}
        submitting={submitting}
        reasonOptions={mutationReasonOptions}
        reasonsUnavailable={mutationReasons.isPending || mutationReasons.isError || activeMutationReasons.length === 0}
        onChange={setUpdateDraft}
        onCancel={() => !submitting && setSelectedReason(null)}
        onSubmit={() => void submitUpdateReason()}
      />

      <StepUpModal
        open={stepUpOpen}
        onCancel={() => {
          setStepUpOpen(false);
          setPendingAfterStepUp(null);
          setSubmitting(false);
        }}
        onVerified={retryAfterStepUp}
      />
    </div>
  );
}

function policyValid(draft: PolicyDraft, reasons: ReasonCode[]): boolean {
  return draft.idle >= 5 && draft.idle <= 120 && draft.absolute >= 1 && draft.absolute <= 24 &&
    draft.absolute * 60 > draft.idle && draft.retention >= 365 && draft.retention <= 3650 &&
    reasons.some((reason) => reason.code === draft.reasonCode) &&
    validMutationMetadata(draft.ticketReference, draft.note);
}

function reasonCreateValid(draft: CreateReasonDraft, reasons: ReasonCode[]): boolean {
  const label = draft.label.trim();
  return codePattern.test(draft.code) && label.length > 0 && label.length <= 80 &&
    reasons.some((reason) => reason.code === draft.reasonCode) &&
    validMutationMetadata(draft.ticketReference, draft.note) && !sensitiveText.test(label);
}

function reasonUpdateValid(draft: UpdateReasonDraft, reasons: ReasonCode[]): boolean {
  const label = draft.label.trim();
  return label.length > 0 && label.length <= 80 && reasons.some((reason) => reason.code === draft.reasonCode) &&
    validMutationMetadata(draft.ticketReference, draft.note) && !sensitiveText.test(label);
}

interface MutationReasonModalProps<T> {
  draft: T;
  submitting: boolean;
  reasonOptions: Array<{ value: string; label: string }>;
  reasonsUnavailable: boolean;
  onChange: (draft: T) => void;
  onCancel: () => void;
  onSubmit: () => void;
}

function MutationReasonFields<T extends { reasonCode: string; ticketReference: string; note: string }>({
  draft,
  reasonOptions,
  reasonsUnavailable,
  onChange,
}: Pick<MutationReasonModalProps<T>, 'draft' | 'reasonOptions' | 'reasonsUnavailable' | 'onChange'>) {
  return (
    <>
      {reasonsUnavailable && <Alert type="error" showIcon message="目录变更原因暂时不可用，提交已禁止" />}
      <Form.Item label="目录变更原因">
        <Select
          aria-label="目录变更原因"
          value={draft.reasonCode || undefined}
          disabled={reasonsUnavailable}
          virtual={false}
          options={reasonOptions}
          onChange={(value) => onChange({ ...draft, reasonCode: value })}
        />
      </Form.Item>
      <Form.Item label="工单编号">
        <Input aria-label="目录工单编号" value={draft.ticketReference} maxLength={128} onChange={(event) => onChange({ ...draft, ticketReference: event.target.value })} />
      </Form.Item>
      <Form.Item label="补充说明">
        <Input.TextArea aria-label="目录补充说明" value={draft.note} maxLength={500} rows={3} onChange={(event) => onChange({ ...draft, note: event.target.value })} />
      </Form.Item>
    </>
  );
}

function ReasonCreateModal({
  open, draft, submitting, reasonOptions, reasonsUnavailable, onChange, onCancel, onSubmit,
}: MutationReasonModalProps<CreateReasonDraft> & { open: boolean }) {
  return (
    <Modal
      title="新增标准原因码"
      open={open}
      okText="确认创建"
      cancelText="取消"
      confirmLoading={submitting}
      okButtonProps={{ disabled: submitting || reasonsUnavailable }}
      cancelButtonProps={{ disabled: submitting }}
      maskClosable={false}
      destroyOnHidden
      onOk={onSubmit}
      onCancel={onCancel}
    >
      <Form layout="vertical" requiredMark={false}>
        <Form.Item label="原因码" extra="创建后不可修改，仅使用小写字母、数字和下划线。">
          <Input aria-label="原因码" value={draft.code} maxLength={64} onChange={(event) => onChange({ ...draft, code: event.target.value })} />
        </Form.Item>
        <Form.Item label="原因分类">
          <Select aria-label="原因分类" value={draft.category} options={categoryOptions} virtual={false} onChange={(value) => onChange({ ...draft, category: value })} />
        </Form.Item>
        <Form.Item label="显示名称">
          <Input aria-label="显示名称" value={draft.label} maxLength={80} onChange={(event) => onChange({ ...draft, label: event.target.value })} />
        </Form.Item>
        <MutationReasonFields draft={draft} reasonOptions={reasonOptions} reasonsUnavailable={reasonsUnavailable} onChange={onChange} />
      </Form>
    </Modal>
  );
}

function ReasonUpdateModal({
  target, draft, submitting, reasonOptions, reasonsUnavailable, onChange, onCancel, onSubmit,
}: MutationReasonModalProps<UpdateReasonDraft> & { target: ReasonCode | null }) {
  return (
    <Modal
      title={target ? `编辑原因码：${target.code}` : '编辑原因码'}
      open={Boolean(target)}
      okText="确认更新"
      cancelText="取消"
      confirmLoading={submitting}
      okButtonProps={{ disabled: submitting || reasonsUnavailable }}
      cancelButtonProps={{ disabled: submitting }}
      maskClosable={false}
      destroyOnHidden
      onOk={onSubmit}
      onCancel={onCancel}
    >
      <Form layout="vertical" requiredMark={false}>
        <Form.Item label="原因分类">
          <Input value={target ? categoryLabels[target.category] : ''} disabled />
        </Form.Item>
        <Form.Item label="显示名称">
          <Input aria-label="显示名称" value={draft.label} maxLength={80} onChange={(event) => onChange({ ...draft, label: event.target.value })} />
        </Form.Item>
        <Form.Item label="有效状态">
          <Space>
            <Switch aria-label="原因码有效状态" checked={draft.active} onChange={(active) => onChange({ ...draft, active })} />
            <Typography.Text>{draft.active ? '有效' : '已停用'}</Typography.Text>
          </Space>
        </Form.Item>
        <MutationReasonFields draft={draft} reasonOptions={reasonOptions} reasonsUnavailable={reasonsUnavailable} onChange={onChange} />
      </Form>
    </Modal>
  );
}
