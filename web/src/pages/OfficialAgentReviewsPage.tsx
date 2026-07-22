import { ReloadOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Card, Checkbox, Descriptions, Modal, Space, Table, Tag, Typography } from 'antd';
import { useRef, useState } from 'react';

import {
  APIError,
  decideOfficialRollback,
  getOfficialRollbacks,
  getOfficialSubmissions,
  newIdempotencyKey,
  postOfficialMutation,
} from '../api/client';
import type { OfficialOperation, OfficialRollbackApproval, OfficialSubmission, ReasonInput } from '../api/contracts';
import { useAuth } from '../auth/AuthProvider';
import { StepUpModal } from '../auth/StepUpModal';
import { CloudBoundary } from '../components/CloudBoundary';
import { OperationStatus } from '../components/OperationStatus';
import { ReasonForm } from '../components/ReasonForm';

type SubmissionDecision = 'approve' | 'reject';
interface PendingReview {
  submission: OfficialSubmission;
  decision: SubmissionDecision;
  channels: string[];
  reason: ReasonInput;
  idempotencyKey: string;
}

interface PendingRollbackDecision {
  approval: OfficialRollbackApproval;
  action: 'approve' | 'reject';
  key: string;
}

export function OfficialAgentReviewsPage() {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const adminID = auth.session?.administrator.admin_id;
  const [selectedSubmission, setSelectedSubmission] = useState<OfficialSubmission | null>(null);
  const [decision, setDecision] = useState<SubmissionDecision | null>(null);
  const [channels, setChannels] = useState<string[]>([]);
  const [operation, setOperation] = useState<OfficialOperation | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [stepUpOpen, setStepUpOpen] = useState(false);
  const pendingReview = useRef<PendingReview | null>(null);
  const pendingRollbackDecision = useRef<PendingRollbackDecision | null>(null);

  const submissions = useQuery({
    queryKey: ['official-submissions', 'pending'],
    queryFn: () => getOfficialSubmissions(new URLSearchParams({ status: 'pending', limit: '50' })),
    retry: false,
  });
  const rollbacks = useQuery({
    queryKey: ['official-rollbacks', 'pending_for_me'],
    queryFn: () => getOfficialRollbacks(new URLSearchParams({ view: 'pending_for_me', limit: '50' })),
    retry: false,
    refetchInterval: (query) => query.state.data?.items.some((item) => ['queued', 'executing', 'reconciling'].includes(item.execution_status)) ? 2_000 : false,
  });

  const review = useMutation({
    mutationFn: (pending: PendingReview) => postOfficialMutation(
      `/official-agent-submissions/${pending.submission.submission_id}/review`,
      {
        expected_revision: pending.submission.revision,
        expected_target_digest: pending.submission.content_digest,
        reason_code: pending.reason.reason_code,
        ticket_reference: pending.reason.ticket_reference,
        note: pending.reason.note,
        payload: pending.decision === 'approve'
          ? { decision: 'approve', initial_channels: pending.channels }
          : { decision: 'reject', review_reason_code: pending.reason.reason_code, safe_note: pending.reason.note },
      },
      pending.idempotencyKey,
    ),
    onSuccess: (result) => {
      setOperation(result);
      setMessage('审核请求已排队；只有 Cloud 原子事务完成后才会显示执行成功。');
      setDecision(null);
      setSelectedSubmission(null);
      setStepUpOpen(false);
      pendingReview.current = null;
      void queryClient.invalidateQueries({ queryKey: ['official-submissions'] });
    },
  });

  const executeReview = async (pending: PendingReview) => {
    pendingReview.current = pending;
    try {
      await review.mutateAsync(pending);
    } catch (cause) {
      if (cause instanceof APIError && cause.code === 'STEP_UP_REQUIRED') {
        setStepUpOpen(true);
        return;
      }
      pendingReview.current = null;
      if (cause instanceof APIError && (cause.code === 'STATE_CONFLICT' || cause.code === 'TARGET_DIGEST_MISMATCH')) {
        setMessage('提交内容或修订已变化，已刷新待审列表；本次审核未执行。');
        void queryClient.invalidateQueries({ queryKey: ['official-submissions'] });
        return;
      }
      setMessage(cause instanceof APIError ? cause.message : '审核请求未能排队');
    }
  };

  const rollback = useMutation({
    mutationFn: ({ approval, action, key }: PendingRollbackDecision) => decideOfficialRollback(approval.id, action, key),
    onSuccess: () => {
      setMessage('回滚审批状态已更新；批准仅代表回滚进入队列，不代表 Cloud 已完成。');
      setStepUpOpen(false);
      pendingRollbackDecision.current = null;
      void queryClient.invalidateQueries({ queryKey: ['official-rollbacks'] });
    },
    onError: (cause, pending) => {
      if (cause instanceof APIError && cause.code === 'STEP_UP_REQUIRED') {
        pendingRollbackDecision.current = pending;
        setStepUpOpen(true);
      }
      else setMessage(cause instanceof APIError ? cause.message : '回滚审批未能完成');
    },
  });

  const submissionItems = submissions.data?.items ?? [];
  const rollbackItems = rollbacks.data?.items ?? [];
  const unavailable = submissions.error ?? rollbacks.error;
  return (
    <div className="official-agent-reviews-page">
      <div className="page-heading">
        <div>
          <Typography.Title level={3}>官方 Agent 审核</Typography.Title>
          <Typography.Paragraph type="secondary">审核冻结提交和双人回滚；审批结论与 Cloud 执行状态始终分开。</Typography.Paragraph>
        </div>
        <Button icon={<ReloadOutlined aria-hidden />} onClick={() => {
          void submissions.refetch();
          void rollbacks.refetch();
        }}>刷新待审</Button>
      </div>
      <Alert
        className="page-alert"
        type="info"
        showIcon
        message="策略快照将在 Cloud 原子发布时固定"
        description="批准发布会重新执行规范化、DLP、模型/工具、依赖、Runtime 与摘要校验；本页面不能绕过。"
      />
      {message && <Alert className="page-alert" type="warning" showIcon message={message} />}
      {operation && <Card size="small"><Space>最近审核操作 <OperationStatus state={operation.state} /></Space></Card>}

      <CloudBoundary error={unavailable} empty={false} onRetry={() => {
        void submissions.refetch();
        void rollbacks.refetch();
      }}>
        <Card className="data-card" title="冻结内容提交">
          {submissionItems.length === 0 ? <Typography.Text type="secondary">暂无待审提交</Typography.Text> : submissionItems.map((item) => {
            const selfReview = item.submitted_by_admin_id === adminID;
            return (
              <Card key={item.submission_id} size="small" style={{ marginBottom: 12 }}>
                <Descriptions size="small" column={2}>
                  <Descriptions.Item label="名称">{item.display_name}</Descriptions.Item>
                  <Descriptions.Item label="草稿修订">{item.draft_revision}</Descriptions.Item>
                  <Descriptions.Item label="冻结内容摘要" span={2}><Typography.Text code>{item.content_digest}</Typography.Text></Descriptions.Item>
                  <Descriptions.Item label="提交人">{item.submitted_by_admin_id}</Descriptions.Item>
                  <Descriptions.Item label="状态"><Tag color="processing">待审核</Tag></Descriptions.Item>
                </Descriptions>
                <Checkbox.Group value={selectedSubmission?.submission_id === item.submission_id ? channels : []} onChange={(value) => {
                  setSelectedSubmission(item);
                  setChannels(value.map(String));
                }}>
                  <Space>
                    <Checkbox aria-label="内部渠道" value="internal">内部渠道</Checkbox>
                    <Checkbox aria-label="稳定渠道" value="stable">稳定渠道</Checkbox>
                  </Space>
                </Checkbox.Group>
                <Space style={{ marginLeft: 16 }}>
                  <Button
                    type="primary"
                    disabled={selfReview || (selectedSubmission?.submission_id === item.submission_id ? channels.length === 0 : true)}
                    onClick={() => {
                      setSelectedSubmission(item);
                      setDecision('approve');
                    }}
                  >批准发布</Button>
                  <Button danger disabled={selfReview} onClick={() => {
                    setSelectedSubmission(item);
                    setDecision('reject');
                  }}>拒绝提交</Button>
                  {selfReview && <Typography.Text type="danger">不能审核自己提交的内容</Typography.Text>}
                </Space>
              </Card>
            );
          })}
        </Card>

        <Card className="data-card" title="回滚双人审批" style={{ marginTop: 16 }}>
          <Table
            rowKey="id"
            pagination={false}
            dataSource={rollbackItems}
            columns={[
              { title: '发布 ID', dataIndex: 'release_id' },
              { title: '目标版本', dataIndex: 'target_version_id' },
              { title: '发起人', dataIndex: 'requested_by_admin_id' },
              { title: '审批状态', dataIndex: 'approval_status' },
              {
                title: '操作',
                render: (_, item: OfficialRollbackApproval) => (
                  <Space>
                    <Button
                      type="primary"
                      disabled={item.requested_by_admin_id === adminID || item.approval_status !== 'pending_review'}
                      loading={rollback.isPending}
                      onClick={() => rollback.mutate({ approval: item, action: 'approve', key: newIdempotencyKey() })}
                    >批准回滚</Button>
                    <Button
                      danger
                      disabled={item.requested_by_admin_id === adminID || item.approval_status !== 'pending_review'}
                      onClick={() => rollback.mutate({ approval: item, action: 'reject', key: newIdempotencyKey() })}
                    >拒绝回滚</Button>
                  </Space>
                ),
              },
            ]}
          />
        </Card>
      </CloudBoundary>

      <Modal title={decision === 'approve' ? '批准并发布不可变版本' : '拒绝冻结提交'} open={Boolean(decision && selectedSubmission)} footer={null} destroyOnHidden onCancel={() => setDecision(null)}>
        <Typography.Paragraph type="secondary">
          {decision === 'approve' ? `将发布到：${channels.join('、')}` : '拒绝不会修改或删除 Developer 的本地工作。'}
        </Typography.Paragraph>
        {decision && selectedSubmission && (
          <ReasonForm
            usage="official_agent"
            submitLabel={decision === 'approve' ? '批准发布' : '确认拒绝'}
            pending={review.isPending}
            onSubmit={(reason) => executeReview({
              submission: selectedSubmission,
              decision,
              channels: decision === 'approve' ? [...channels] : [],
              reason,
              idempotencyKey: newIdempotencyKey(),
            })}
          />
        )}
      </Modal>
      <StepUpModal
        open={stepUpOpen}
        onCancel={() => {
          setStepUpOpen(false);
          pendingReview.current = null;
          pendingRollbackDecision.current = null;
        }}
        onVerified={async () => {
          if (pendingReview.current) {
            await executeReview(pendingReview.current);
            return;
          }
          if (pendingRollbackDecision.current) await rollback.mutateAsync(pendingRollbackDecision.current);
        }}
      />
    </div>
  );
}
