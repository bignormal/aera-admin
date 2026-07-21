import { zodResolver } from '@hookform/resolvers/zod';
import { CheckCircleFilled, CopyOutlined, SafetyCertificateOutlined } from '@ant-design/icons';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Card, Checkbox, Form, Input, Result, Space, Spin, Typography, message } from 'antd';
import { useEffect, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { QRCodeSVG } from 'qrcode.react';
import { useLocation, useNavigate } from 'react-router-dom';
import { z } from 'zod';

import { APIError, postJSON } from '../api/client';
import type { ActivationPreparation, ActivationResult } from '../api/contracts';
import { administratorPasswordSchema } from '../auth/password';
import { copySensitiveText } from '../security/clipboard';
import '../styles/auth.css';

const activationSchema = z
  .object({
    password: administratorPasswordSchema,
    confirmPassword: z.string().min(1, '请再次输入密码'),
    totpCode: z.string().regex(/^\d{6}$/, '请输入 6 位动态验证码'),
  })
  .refine((values) => values.password === values.confirmPassword, {
    path: ['confirmPassword'],
    message: '两次输入的密码不一致',
  });

type ActivationFields = z.infer<typeof activationSchema>;

function safeActivationToken(hash: string): string {
  const value = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash).get('token') ?? '';
  return value.length > 0 && value.length <= 128 ? value : '';
}

function requestErrorMessage(error: unknown): string {
  return error instanceof APIError ? error.message : '激活服务暂时不可用，请稍后重试';
}

export function ActivatePage() {
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [token, setToken] = useState(() => safeActivationToken(location.hash));
  const [result, setResult] = useState<ActivationResult | null>(null);
  const [saved, setSaved] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const form = useForm<ActivationFields>({
    resolver: zodResolver(activationSchema),
    defaultValues: { password: '', confirmPassword: '', totpCode: '' },
  });

  useEffect(() => {
    if (location.hash !== '') {
      void navigate({ pathname: location.pathname, search: location.search }, { replace: true });
    }
  }, [location.hash, location.pathname, location.search, navigate]);

  useEffect(
    () => () => queryClient.removeQueries({ queryKey: ['activation-preparation'] }),
    [queryClient],
  );

  const preparation = useQuery({
    queryKey: ['activation-preparation'],
    enabled: location.hash === '' && token !== '',
    queryFn: () => postJSON<ActivationPreparation>('/auth/activation/prepare', { token }),
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
  });

  if (!token && !result) {
    return (
      <main className="auth-page auth-page-centered">
        <Result
          status="warning"
          title="激活链接无效"
          subTitle="请使用最近一次由超级管理员生成的完整激活链接。"
          extra={<Button href="/login">返回登录</Button>}
        />
      </main>
    );
  }

  if (!result && preparation.isPending) {
    return (
      <main className="auth-page auth-page-centered">
        <Space direction="vertical" align="center">
          <Spin size="large" />
          <Typography.Text>正在验证一次性激活链接…</Typography.Text>
        </Space>
      </main>
    );
  }

  if (!result && (preparation.isError || !preparation.data)) {
    return (
      <main className="auth-page auth-page-centered">
        <Result
          status="error"
          title="无法继续激活"
          subTitle={requestErrorMessage(preparation.error)}
          extra={<Button href="/login">返回登录</Button>}
        />
      </main>
    );
  }

  const activate = form.handleSubmit(async (values) => {
    setSubmitError(null);
    setSubmitting(true);
    const pending = postJSON<ActivationResult>('/auth/activate', {
      token,
      password: values.password,
      totp_code: values.totpCode,
    });
    form.reset({ password: '', confirmPassword: '', totpCode: '' });
    try {
      const activation = await pending;
      setToken('');
      setResult(activation);
      queryClient.removeQueries({ queryKey: ['activation-preparation'] });
    } catch (error) {
      setSubmitError(requestErrorMessage(error));
    } finally {
      setSubmitting(false);
    }
  });

  if (result) {
    return (
      <main className="auth-page auth-page-centered">
        <Card className="activation-card recovery-card" variant="borderless">
          <CheckCircleFilled className="activation-success-icon" />
          <Typography.Title level={2}>管理员安全凭证已启用</Typography.Title>
          <Typography.Paragraph type="secondary">
            以下恢复码只展示这一次。每个恢复码只能使用一次，请保存到公司批准的密码管理器。
          </Typography.Paragraph>
          <div className="recovery-code-grid" aria-label="恢复码">
            {result.recovery_codes.map((code) => <code key={code}>{code}</code>)}
          </div>
          {copyError && <Alert type="error" showIcon message={copyError} />}
          <Space direction="vertical" size={16} className="activation-confirmation">
            <Button
              icon={<CopyOutlined />}
              onClick={() => void (async () => {
                setCopyError(null);
                try {
                  await copySensitiveText(result.recovery_codes.join('\n'));
                  void message.success('恢复码已复制，请立即存入批准的密码管理器');
                } catch {
                  setCopyError('复制失败，请手动选择并保存恢复码');
                }
              })()}
            >
              复制全部恢复码
            </Button>
            <Checkbox checked={saved} onChange={(event) => setSaved(event.target.checked)}>
              我已安全保存全部恢复码
            </Checkbox>
            <Button type="primary" size="large" href="/login" disabled={!saved}>
              前往安全登录
            </Button>
          </Space>
        </Card>
      </main>
    );
  }

  const details = preparation.data;
  if (!details) return null;
  const resetting = details.purpose === 'totp_reset';
  return (
    <main className="auth-page auth-page-centered">
      <Card className="activation-card" variant="borderless">
        <div className="auth-card-heading">
          <Typography.Text className="auth-kicker">ONE-TIME ACTIVATION</Typography.Text>
          <Typography.Title level={2}>{resetting ? '重新绑定 TOTP' : '启用管理员凭证'}</Typography.Title>
          <Typography.Paragraph type="secondary">
            {details.display_name} · <strong>{details.masked_identity}</strong>
          </Typography.Paragraph>
        </div>
        <Alert
          type="info"
          showIcon
          message={resetting ? '现有会话已撤销' : '此身份独立于普通 Aera 用户账号'}
          description={resetting ? '请使用当前独立管理员密码完成重新绑定。' : '请创建专用密码，不要复用个人或客户账号密码。'}
        />
        <div className="activation-grid">
          <section className="totp-setup">
            <div className="totp-qr" aria-label="TOTP 配置二维码">
              <QRCodeSVG value={details.provisioning_uri} size={176} level="M" title="Aera Admin TOTP 配置二维码" />
            </div>
            <Typography.Text strong><SafetyCertificateOutlined /> 在认证器中扫码</Typography.Text>
            <Typography.Paragraph type="secondary">
              扫码后输入新生成的 6 位验证码，系统不会显示或记录 TOTP 密钥文本。
            </Typography.Paragraph>
          </section>

          <Form layout="vertical" requiredMark={false} onFinish={() => void activate()}>
            {submitError && <Alert className="auth-alert" type="error" showIcon message={submitError} />}
            <Form.Item
              label={resetting ? '当前独立密码' : '创建独立密码'}
              validateStatus={form.formState.errors.password ? 'error' : undefined}
              help={form.formState.errors.password?.message}
            >
              <Controller
                name="password"
                control={form.control}
                render={({ field }) => (
                  <Input.Password {...field} aria-label={resetting ? '当前独立密码' : '创建独立密码'} autoComplete="new-password" />
                )}
              />
            </Form.Item>
            <Form.Item
              label="确认密码"
              validateStatus={form.formState.errors.confirmPassword ? 'error' : undefined}
              help={form.formState.errors.confirmPassword?.message}
            >
              <Controller
                name="confirmPassword"
                control={form.control}
                render={({ field }) => <Input.Password {...field} aria-label="确认密码" autoComplete="new-password" />}
              />
            </Form.Item>
            <Form.Item
              label="动态验证码"
              validateStatus={form.formState.errors.totpCode ? 'error' : undefined}
              help={form.formState.errors.totpCode?.message}
            >
              <Controller
                name="totpCode"
                control={form.control}
                render={({ field }) => (
                  <Input {...field} aria-label="动态验证码" inputMode="numeric" autoComplete="one-time-code" maxLength={6} />
                )}
              />
            </Form.Item>
            <Button type="primary" htmlType="submit" size="large" block loading={submitting}>
              完成安全激活
            </Button>
          </Form>
        </div>
      </Card>
    </main>
  );
}
