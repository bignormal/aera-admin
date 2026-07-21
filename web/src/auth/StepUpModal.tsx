import { zodResolver } from '@hookform/resolvers/zod';
import { Alert, Form, Input, Modal, Typography } from 'antd';
import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { z } from 'zod';

import { APIError, postJSON } from '../api/client';
import type { SessionDocument } from '../api/contracts';
import { useAuth } from './AuthProvider';

const schema = z.object({ totpCode: z.string().trim().regex(/^\d{6}$/, '请输入 6 位动态验证码') });
type Fields = z.infer<typeof schema>;

interface StepUpModalProps {
  open: boolean;
  onCancel: () => void;
  onVerified: () => Promise<void> | void;
}

export function StepUpModal({ open, onCancel, onVerified }: StepUpModalProps) {
  const auth = useAuth();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const form = useForm<Fields>({ resolver: zodResolver(schema), defaultValues: { totpCode: '' } });

  const verify = form.handleSubmit(async (values) => {
    setSubmitting(true);
    setError(null);
    const pending = postJSON<SessionDocument>('/auth/step-up', { totp_code: values.totpCode.trim() });
    form.resetField('totpCode', { defaultValue: '' });
    try {
      const session = await pending;
      await auth.establishSession(session);
      form.reset({ totpCode: '' });
      setError(null);
      await onVerified();
    } catch (requestError) {
      setError(requestError instanceof APIError ? requestError.message : '二次验证暂时不可用');
    } finally {
      setSubmitting(false);
    }
  });

  return (
    <Modal
      title="高风险操作二次验证"
      open={open}
      okText="验证并继续"
      cancelText="取消操作"
      confirmLoading={submitting}
      okButtonProps={{ disabled: submitting }}
      maskClosable={false}
      closable={!submitting}
      cancelButtonProps={{ disabled: submitting }}
      destroyOnHidden
      onOk={() => void verify()}
      onCancel={() => {
        if (submitting) return;
        form.reset({ totpCode: '' });
        setError(null);
        onCancel();
      }}
    >
      <Typography.Paragraph type="secondary">
        请输入认证器当前显示的动态验证码。恢复码不能用于批准高风险操作。
      </Typography.Paragraph>
      {error && <Alert type="error" showIcon message={error} />}
      <Form layout="vertical" requiredMark={false} className="modal-form">
        <Form.Item
          label="动态验证码"
          validateStatus={form.formState.errors.totpCode ? 'error' : undefined}
          help={form.formState.errors.totpCode?.message}
        >
          <Controller
            name="totpCode"
            control={form.control}
            render={({ field }) => (
              <Input
                {...field}
                aria-label="二次验证动态验证码"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
              />
            )}
          />
        </Form.Item>
      </Form>
    </Modal>
  );
}
