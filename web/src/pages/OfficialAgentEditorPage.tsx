import { ReloadOutlined, SafetyCertificateOutlined, SendOutlined, SaveOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Card, Form, Input, Modal, Space, Tag, Typography } from 'antd';
import { useState } from 'react';
import { useParams } from 'react-router-dom';

import {
  APIError,
  getOfficialDefinition,
  getOfficialDrafts,
  getOfficialDraftValidation,
  newIdempotencyKey,
  patchOfficialMutation,
  postOfficialMutation,
} from '../api/client';
import type { OfficialOperation, ReasonInput } from '../api/contracts';
import { CloudBoundary } from '../components/CloudBoundary';
import { OperationStatus } from '../components/OperationStatus';
import { ReasonForm } from '../components/ReasonForm';

type EditorAction = 'save' | 'submit';

function values(raw: string): string[] {
  return raw.split(',').map((item) => item.trim()).filter(Boolean);
}

export function OfficialAgentEditorPage() {
  const { definitionID = '' } = useParams();
  const queryClient = useQueryClient();
  const [displayNameOverride, setDisplayNameOverride] = useState<string | null>(null);
  const [promptOverride, setPromptOverride] = useState<string | null>(null);
  const [providersOverride, setProvidersOverride] = useState<string | null>(null);
  const [modelsOverride, setModelsOverride] = useState<string | null>(null);
  const [action, setAction] = useState<EditorAction | null>(null);
  const [operation, setOperation] = useState<OfficialOperation | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const definition = useQuery({
    queryKey: ['official-definition', definitionID],
    queryFn: () => getOfficialDefinition(definitionID),
    enabled: Boolean(definitionID),
    retry: false,
  });
  const drafts = useQuery({
    queryKey: ['official-drafts'],
    queryFn: () => getOfficialDrafts(new URLSearchParams({ limit: '100' })),
    retry: false,
  });
  const draft = drafts.data?.items.find((item) => item.definition_id === definitionID && item.status === 'active');
  const displayName = displayNameOverride ?? draft?.display_name ?? definition.data?.display_name ?? '';
  const prompt = promptOverride ?? draft?.manifest.identity.system_prompt ?? '';
  const providers = providersOverride ?? draft?.manifest.model_constraints.allowed_providers.join(', ') ?? 'openai';
  const models = modelsOverride ?? draft?.manifest.model_constraints.allowed_models.join(', ') ?? 'gpt-5';

  const validation = useMutation({
    mutationFn: () => {
      if (!draft) throw new Error('请先保存草稿');
      return getOfficialDraftValidation(draft.draft_id);
    },
    onError: (cause) => setMessage(cause instanceof APIError ? cause.message : '草稿安全校验未能完成'),
  });

  const mutation = useMutation({
    mutationFn: async ({ kind, reason }: { kind: EditorAction; reason: ReasonInput }) => {
      const common = {
        reason_code: reason.reason_code,
        ticket_reference: reason.ticket_reference,
        note: reason.note,
      };
      if (kind === 'submit') {
        if (!draft) throw new Error('请先保存草稿');
        return postOfficialMutation(
          `/official-agent-drafts/${draft.draft_id}/submit`,
          {
            ...common,
            expected_revision: draft.revision,
            expected_target_digest: draft.content_digest,
            payload: {},
          },
          newIdempotencyKey(),
        );
      }
      const manifest = {
        schema_version: 1 as const,
        identity: { system_prompt: prompt.trim() },
        assets: draft?.manifest.assets ?? [],
        model_constraints: { allowed_providers: values(providers), allowed_models: values(models) },
        tools: draft?.manifest.tools ?? { allowed: [], denied: [] },
        dependencies: draft?.manifest.dependencies ?? [],
        runtime_compatibility: draft?.manifest.runtime_compatibility ?? { minimum_version: 'v0.18.0' },
      };
      const payload = {
        ...(draft ? {} : { definition_id: definitionID }),
        ...(draft?.base_version_id ? { base_version_id: draft.base_version_id } : {}),
        kind: draft?.kind ?? 'initial',
        display_name: displayName.trim(),
        manifest,
        bundle: draft?.bundle ?? { assets: [] },
      };
      if (draft) {
        return patchOfficialMutation(
          `/official-agent-drafts/${draft.draft_id}`,
          {
            ...common,
            expected_revision: draft.revision,
            expected_target_digest: draft.content_digest,
            payload,
          },
          newIdempotencyKey(),
        );
      }
      return postOfficialMutation(
        '/official-agent-drafts',
        { ...common, expected_revision: 1, payload },
        newIdempotencyKey(),
      );
    },
    onSuccess: (result) => {
      setOperation(result);
      setAction(null);
      setMessage('请求已排队，等待 Cloud 返回真实结果；当前页面不会把排队显示为保存或发布成功。');
      void queryClient.invalidateQueries({ queryKey: ['official-drafts'] });
    },
    onError: (cause) => {
      if (cause instanceof APIError && (cause.code === 'STATE_CONFLICT' || cause.code === 'TARGET_DIGEST_MISMATCH')) {
        setMessage('草稿版本已变化，已请求刷新最新修订；请核对后重新提交。');
        void queryClient.invalidateQueries({ queryKey: ['official-drafts'] });
        return;
      }
      setMessage(cause instanceof APIError ? cause.message : '官方 Agent 草稿操作未能排队');
    },
  });

  const unavailable = definition.error ?? drafts.error;
  return (
    <div className="official-agent-editor-page">
      <div className="page-heading">
        <div>
          <Typography.Title level={3}>编辑官方 Agent 草稿</Typography.Title>
          <Typography.Paragraph type="secondary">草稿可以编辑；提交后形成冻结快照，只有另一位 Super Admin 能审核发布不可变版本。</Typography.Paragraph>
        </div>
        <Button icon={<ReloadOutlined aria-hidden />} onClick={() => {
          void definition.refetch();
          void drafts.refetch();
        }}>刷新修订</Button>
      </div>
      <CloudBoundary error={unavailable} empty={false} onRetry={() => {
        void definition.refetch();
        void drafts.refetch();
      }}>
        <Card className="data-card">
          <Space direction="vertical" size={4} style={{ marginBottom: 16 }}>
            <Typography.Text strong>{definition.data?.display_name ?? '加载中…'}</Typography.Text>
            {draft ? (
              <>
                <Tag color="blue">草稿修订号：{draft.revision}</Tag>
                <Typography.Text code>{draft.content_digest}</Typography.Text>
              </>
            ) : <Tag>尚无草稿，首次保存将创建初始草稿</Tag>}
          </Space>
          <Form layout="vertical">
            <Form.Item label="显示名称">
              <Input aria-label="显示名称" maxLength={100} value={displayName} onChange={(event) => setDisplayNameOverride(event.target.value)} />
            </Form.Item>
            <Form.Item label="系统提示词">
              <Input.TextArea aria-label="系统提示词" rows={8} maxLength={262_144} value={prompt} onChange={(event) => setPromptOverride(event.target.value)} />
            </Form.Item>
            <Form.Item label="允许的模型提供商（逗号分隔）">
              <Input aria-label="允许的模型提供商" value={providers} onChange={(event) => setProvidersOverride(event.target.value)} />
            </Form.Item>
            <Form.Item label="允许的模型（逗号分隔）">
              <Input aria-label="允许的模型" value={models} onChange={(event) => setModelsOverride(event.target.value)} />
            </Form.Item>
            <Space wrap>
              <Button
                icon={<SafetyCertificateOutlined aria-hidden />}
                disabled={!draft}
                loading={validation.isPending}
                onClick={() => validation.mutate()}
              >运行安全校验</Button>
              <Button icon={<SaveOutlined aria-hidden />} onClick={() => setAction('save')}>保存草稿</Button>
              <Button type="primary" icon={<SendOutlined aria-hidden />} disabled={!draft} onClick={() => setAction('submit')}>提交审核</Button>
            </Space>
          </Form>
        </Card>
      </CloudBoundary>
      {validation.data && (
        <Alert
          className="page-alert"
          type={validation.data.valid ? 'success' : 'warning'}
          showIcon
          message={validation.data.valid ? '草稿通过当前安全校验' : '草稿尚未通过安全校验'}
          description={validation.data.findings.length === 0 ? '没有安全发现。' : validation.data.findings.map((finding) => `${finding.code}: ${finding.path}`).join('；')}
        />
      )}
      {message && <Alert className="page-alert" type={operation ? 'info' : 'warning'} showIcon message={message} />}
      {operation && <Card size="small"><Space>Cloud 操作状态 <OperationStatus state={operation.state} /></Space></Card>}

      <Modal title={action === 'submit' ? '确认提交冻结快照' : '确认保存草稿'} open={Boolean(action)} footer={null} destroyOnHidden onCancel={() => setAction(null)}>
        <Typography.Paragraph type="secondary">
          {action === 'submit' ? '提交后当前内容摘要将冻结；后续修改必须创建新草稿修订。' : '保存只会排队写入 Cloud 草稿，不会直接发布版本。'}
        </Typography.Paragraph>
        {action && (
          <ReasonForm
            usage="official_agent"
            submitLabel={action === 'submit' ? '确认提交审核' : '排队保存草稿'}
            pending={mutation.isPending}
            onSubmit={(reason) => mutation.mutateAsync({ kind: action, reason }).then(() => undefined)}
          />
        )}
      </Modal>
    </div>
  );
}
