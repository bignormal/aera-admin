import { ReloadOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ColumnsType } from 'antd/es/table';
import {
  Alert,
  Button,
  Card,
  Descriptions,
  Drawer,
  Modal,
  Select,
  Space,
  Spin,
  Table,
  Tag,
  Timeline,
  Typography,
} from 'antd';
import { useRef, useState } from 'react';

import {
  APIError,
  newIdempotencyKey,
  postIdempotentJSON,
  postJSON,
  request,
} from '../api/client';
import type {
  ApprovalEvent,
  ApprovalRequest,
  ApprovalStatus,
  Page,
} from '../api/contracts';
import { useAuth } from '../auth/AuthProvider';
import { StepUpModal } from '../auth/StepUpModal';
import { CloudBoundary } from '../components/CloudBoundary';
import { OperationStatus } from '../components/OperationStatus';

type ApprovalView = 'mine' | 'pending_for_me' | 'all';
type ReviewAction = 'approve' | 'reject' | 'cancel';

interface ActionContext {
  action: ReviewAction;
  approvalID: string;
  idempotencyKey?: string;
}

const approvalPresentation: Record<ApprovalStatus, { label: string; color: string }> = {
  pending_review: { label: '待审批', color: 'processing' },
  approved: { label: '已批准', color: 'blue' },
  rejected: { label: '已拒绝', color: 'red' },
  expired: { label: '已过期', color: 'default' },
  cancelled: { label: '已撤回', color: 'default' },
};

const actionPresentation = {
  disable_user: '禁用账号',
  enable_user: '恢复账号',
} as const;

const reasonPresentation: Record<string, string> = {
  customer_request: '客户请求',
  policy_violation: '违反使用政策',
  account_recovery: '账号恢复',
  suspected_compromise: '疑似凭证泄露',
  security_incident: '安全事件处置',
};

const eventPresentation: Record<string, string> = {
  requested: '已发起',
  approved: '已批准',
  rejected: '已拒绝',
  cancelled: '已撤回',
  expired: '已过期',
  execution_updated: '执行状态更新',
};

function formatTime(raw?: string): string {
  if (!raw) return '—';
  const value = new Date(raw);
  if (Number.isNaN(value.getTime())) return '—';
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(value);
}

function maskedIdentity(approval: ApprovalRequest): string {
  return [approval.target_snapshot.masked_email, approval.target_snapshot.masked_phone]
    .filter(Boolean)
    .join(' / ') || '—';
}

function errorMessage(error: unknown): string {
  return error instanceof APIError ? error.message : '审批操作未能完成，请稍后重试';
}

export function ApprovalsPage() {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const [adminView, setAdminView] = useState<Extract<ApprovalView, 'pending_for_me' | 'all'>>('pending_for_me');
  const [cursor, setCursor] = useState('');
  const [cursorHistory, setCursorHistory] = useState<string[]>([]);
  const [selectedID, setSelectedID] = useState<string | null>(null);
  const [activeAction, setActiveAction] = useState<ActionContext | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [stepUpOpen, setStepUpOpen] = useState(false);
  const [stepUpContext, setStepUpContext] = useState<ActionContext | null>(null);
  const actionInFlight = useRef(false);
  const role = auth.session?.administrator.role;
  const adminID = auth.session?.administrator.admin_id;
  const view: ApprovalView = role === 'operator' ? 'mine' : adminView;
  const queryKey = ['approval-requests', view, cursor] as const;

  const approvals = useQuery({
    queryKey,
    queryFn: () =>
      request<Page<ApprovalRequest>>(
        `/approval-requests?view=${view}&limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      ),
    enabled: role === 'operator' || role === 'super_admin',
    retry: false,
    refetchInterval: (query) =>
      query.state.data?.items.some((item) =>
        item.execution_status === 'queued' ||
        item.execution_status === 'executing' ||
        item.execution_status === 'reconciling')
        ? 2000
        : false,
  });

  const detail = useQuery({
    queryKey: ['approval-request', selectedID],
    queryFn: () => request<ApprovalRequest>(`/approval-requests/${selectedID}`),
    enabled: Boolean(selectedID),
    retry: false,
  });

  const updateApproval = (updated: ApprovalRequest) => {
    queryClient.setQueryData<Page<ApprovalRequest>>(queryKey, (current) =>
      current
        ? {
            ...current,
            items: current.items.map((item) => (item.id === updated.id ? updated : item)),
          }
        : current,
    );
    queryClient.setQueryData(['approval-request', updated.id], updated);
  };

  const review = useMutation({
    mutationFn: (context: ActionContext) => {
      const path = `/approval-requests/${context.approvalID}/${context.action}`;
      if (context.action === 'approve') {
        if (!context.idempotencyKey) throw new Error('approval idempotency key is missing');
        return postIdempotentJSON<ApprovalRequest>(path, {}, context.idempotencyKey);
      }
      return postJSON<ApprovalRequest>(path, {});
    },
    onSuccess: (updated) => {
      updateApproval(updated);
      setActiveAction(null);
      setActionError(null);
      setStepUpOpen(false);
      setStepUpContext(null);
    },
  });

  const executeAction = async (context: ActionContext, throwOnFailure = false) => {
    if (actionInFlight.current) return;
    actionInFlight.current = true;
    setActionError(null);
    try {
      await review.mutateAsync(context);
    } catch (error) {
      if (error instanceof APIError && error.code === 'STEP_UP_REQUIRED') {
        setStepUpContext(context);
        setStepUpOpen(true);
        return;
      }
      setActionError(errorMessage(error));
      if (throwOnFailure) throw error;
    } finally {
      actionInFlight.current = false;
    }
  };

  const openAction = (approvalID: string, action: ReviewAction) => {
    setActionError(null);
    setActiveAction({
      approvalID,
      action,
      idempotencyKey: action === 'approve' ? newIdempotencyKey() : undefined,
    });
  };

  const actionTitle =
    activeAction?.action === 'approve'
      ? '批准账号处置申请'
      : activeAction?.action === 'reject'
        ? '拒绝账号处置申请'
        : '撤回账号处置申请';
  const actionLabel =
    activeAction?.action === 'approve'
      ? '确认批准'
      : activeAction?.action === 'reject'
        ? '确认拒绝'
        : '确认撤回';

  const columns: ColumnsType<ApprovalRequest> = [
    {
      title: '目标用户',
      key: 'target',
      width: 250,
      render: (_, approval) => (
        <div className="table-primary-cell">
          <strong>{maskedIdentity(approval)}</strong>
          <span>{approval.target_user_id}</span>
        </div>
      ),
    },
    {
      title: '处置',
      dataIndex: 'action',
      width: 110,
      render: (value: ApprovalRequest['action']) => actionPresentation[value],
    },
    {
      title: '审批状态',
      dataIndex: 'approval_status',
      width: 110,
      render: (value: ApprovalStatus) => (
        <Tag color={approvalPresentation[value].color}>{approvalPresentation[value].label}</Tag>
      ),
    },
    {
      title: '执行状态',
      dataIndex: 'execution_status',
      width: 160,
      render: (value: ApprovalRequest['execution_status']) =>
        value === 'not_started' ? <Tag>未开始</Tag> : <OperationStatus state={value} />,
    },
    {
      title: '标准原因',
      dataIndex: 'reason_code',
      width: 140,
      render: (value: string) => reasonPresentation[value] ?? value,
    },
    {
      title: '过期时间',
      dataIndex: 'expires_at',
      width: 170,
      render: (value: string) => formatTime(value),
    },
    {
      title: '操作',
      key: 'actions',
      width: 240,
      fixed: 'right',
      render: (_, approval) => {
        const pending = approval.approval_status === 'pending_review';
        const canReview = role === 'super_admin' && pending && approval.requested_by_admin_id !== adminID;
        const canCancel = role === 'operator' && pending && approval.requested_by_admin_id === adminID;
        return (
          <Space size={2}>
            <Button type="link" onClick={() => setSelectedID(approval.id)}>查看详情</Button>
            {canReview && (
              <>
                <Button type="link" onClick={() => openAction(approval.id, 'approve')}>批准</Button>
                <Button danger type="link" onClick={() => openAction(approval.id, 'reject')}>拒绝</Button>
              </>
            )}
            {canCancel && (
              <Button danger type="link" onClick={() => openAction(approval.id, 'cancel')}>撤回申请</Button>
            )}
          </Space>
        );
      },
    },
  ];

  const items = approvals.data?.items ?? [];
  const detailDocument = detail.data;

  return (
    <div className="approvals-page">
      <div className="page-heading">
        <div>
          <Typography.Title level={3}>处置审批</Typography.Title>
          <Typography.Paragraph type="secondary">
            审批结论与 Cloud 执行结果分别展示；批准不代表处置已经成功。
          </Typography.Paragraph>
        </div>
        <Button icon={<ReloadOutlined />} loading={approvals.isFetching} onClick={() => void approvals.refetch()}>
          刷新审批
        </Button>
      </div>

      <Card className="filter-card approval-filter-card">
        <div className="filter-control">
          <label htmlFor="approval-view">审批视图</label>
          {role === 'super_admin' ? (
            <Select
              id="approval-view"
              value={adminView}
              style={{ width: 190 }}
              options={[
                { value: 'pending_for_me', label: '待我审批' },
                { value: 'all', label: '全部审批' },
              ]}
              onChange={(next: typeof adminView) => {
                setAdminView(next);
                setCursor('');
                setCursorHistory([]);
              }}
            />
          ) : (
            <Typography.Text>我发起的申请</Typography.Text>
          )}
        </div>
      </Card>

      <CloudBoundary
        error={approvals.error}
        empty={approvals.isSuccess && items.length === 0}
        onRetry={() => void approvals.refetch()}
      >
        <Card className="data-card">
          <div className="data-card-toolbar">
            <Typography.Text strong>审批申请</Typography.Text>
            <Space>
              <Button
                disabled={cursorHistory.length === 0 || approvals.isFetching}
                onClick={() => {
                  const history = [...cursorHistory];
                  setCursor(history.pop() ?? '');
                  setCursorHistory(history);
                }}
              >
                上一页
              </Button>
              <Button
                disabled={!approvals.data?.next_cursor || approvals.isFetching}
                onClick={() => {
                  if (!approvals.data?.next_cursor) return;
                  setCursorHistory((history) => [...history, cursor]);
                  setCursor(approvals.data.next_cursor ?? '');
                }}
              >
                下一页
              </Button>
            </Space>
          </div>
          <Table
            rowKey="id"
            loading={approvals.isPending}
            dataSource={items}
            columns={columns}
            pagination={false}
            scroll={{ x: 1190 }}
          />
        </Card>
      </CloudBoundary>

      <Drawer
        title="审批详情"
        width={600}
        open={Boolean(selectedID)}
        destroyOnHidden
        onClose={() => setSelectedID(null)}
      >
        {detail.isPending && <Spin />}
        {detail.error && (
          <CloudBoundary error={detail.error} empty={false} onRetry={() => void detail.refetch()}>
            {null}
          </CloudBoundary>
        )}
        {detailDocument && (
          <>
            <Descriptions className="approval-details" column={1} size="small" bordered>
              <Descriptions.Item label="脱敏目标">{maskedIdentity(detailDocument)}</Descriptions.Item>
              <Descriptions.Item label="目标用户 ID">{detailDocument.target_user_id}</Descriptions.Item>
              <Descriptions.Item label="处置">{actionPresentation[detailDocument.action]}</Descriptions.Item>
              <Descriptions.Item label="发起人 ID">{detailDocument.requested_by_admin_id}</Descriptions.Item>
              <Descriptions.Item label="标准原因">
                {reasonPresentation[detailDocument.reason_code] ?? detailDocument.reason_code}
              </Descriptions.Item>
              <Descriptions.Item label="工单编号">{detailDocument.ticket_reference || '—'}</Descriptions.Item>
              <Descriptions.Item label="补充说明">{detailDocument.note || '—'}</Descriptions.Item>
              <Descriptions.Item label="预期修订号">{detailDocument.expected_revision}</Descriptions.Item>
              <Descriptions.Item label="审批状态">
                {approvalPresentation[detailDocument.approval_status].label}
              </Descriptions.Item>
              <Descriptions.Item label="执行状态">
                {detailDocument.execution_status === 'not_started'
                  ? '未开始'
                  : <OperationStatus state={detailDocument.execution_status} />}
              </Descriptions.Item>
              <Descriptions.Item label="操作 ID">{detailDocument.operation_id || '—'}</Descriptions.Item>
              <Descriptions.Item label="过期时间">{formatTime(detailDocument.expires_at)}</Descriptions.Item>
              <Descriptions.Item label="创建时间">{formatTime(detailDocument.created_at)}</Descriptions.Item>
              <Descriptions.Item label="更新时间">{formatTime(detailDocument.updated_at)}</Descriptions.Item>
            </Descriptions>
            <Typography.Title className="approval-timeline-title" level={5}>只读审批时间线</Typography.Title>
            <Timeline items={(detailDocument.events ?? []).map(toTimelineItem)} />
          </>
        )}
      </Drawer>

      <Modal
        title={actionTitle}
        open={Boolean(activeAction)}
        okText={actionLabel}
        cancelText="取消"
        confirmLoading={review.isPending}
        okButtonProps={{ danger: activeAction?.action !== 'approve', disabled: review.isPending }}
        maskClosable={!review.isPending}
        closable={!review.isPending}
        destroyOnHidden
        onOk={() => {
          if (activeAction) void executeAction(activeAction);
        }}
        onCancel={() => {
          if (review.isPending) return;
          setActiveAction(null);
          setActionError(null);
        }}
      >
        <Alert
          className="page-alert"
          type={activeAction?.action === 'approve' ? 'info' : 'warning'}
          showIcon
          message={
            activeAction?.action === 'approve'
              ? '批准后进入执行队列，不代表 Cloud 已执行成功'
              : '此操作会保留原始申请与原因，并写入不可变审计'
          }
        />
        {actionError && <Alert type="error" showIcon message={actionError} />}
      </Modal>

      <StepUpModal
        open={stepUpOpen}
        onCancel={() => {
          setStepUpOpen(false);
          setStepUpContext(null);
          setActiveAction(null);
          setActionError(null);
        }}
        onVerified={async () => {
          if (stepUpContext) await executeAction(stepUpContext, true);
        }}
      />
    </div>
  );
}

function toTimelineItem(event: ApprovalEvent) {
  return {
    children: (
      <div className="approval-event">
        <Typography.Text strong>{eventPresentation[event.event_type] ?? event.event_type}</Typography.Text>
        <Typography.Text type="secondary">
          {event.before_status} → {event.after_status} · {formatTime(event.created_at)}
        </Typography.Text>
        <Typography.Text type="secondary">操作人：{event.actor_admin_id}</Typography.Text>
      </div>
    ),
  };
}
