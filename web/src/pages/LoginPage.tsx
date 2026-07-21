import { zodResolver } from '@hookform/resolvers/zod';
import { KeyOutlined, LockOutlined, SafetyCertificateOutlined, UserOutlined } from '@ant-design/icons';
import { Alert, Button, Card, Divider, Form, Input, Space, Typography } from 'antd';
import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { z } from 'zod';

import { APIError, postJSON } from '../api/client';
import type { LoginChallenge, SessionDocument } from '../api/contracts';
import { useAuth } from '../auth/AuthProvider';
import { administratorPasswordSchema } from '../auth/password';
import '../styles/auth.css';

const passwordSchema = z.object({
  email: z.string().trim().email('请输入有效的内部邮箱').max(254, '邮箱长度无效'),
  password: administratorPasswordSchema,
});

const mfaSchema = z.object({
  credential: z.string().trim().min(1, '请输入验证信息').max(128, '验证信息长度无效'),
});

type PasswordFields = z.infer<typeof passwordSchema>;
type MFAFields = z.infer<typeof mfaSchema>;

function errorMessage(error: unknown): string {
  if (error instanceof APIError) {
    if (error.retryAfterSeconds) return `${error.message}（约 ${error.retryAfterSeconds} 秒后可重试）`;
    return error.message;
  }
  return '认证服务暂时不可用，请稍后重试';
}

export function LoginPage() {
  const auth = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [challenge, setChallenge] = useState<LoginChallenge | null>(null);
  const [recoveryMode, setRecoveryMode] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const passwordForm = useForm<PasswordFields>({
    resolver: zodResolver(passwordSchema),
    defaultValues: { email: '', password: '' },
  });
  const mfaForm = useForm<MFAFields>({
    resolver: zodResolver(mfaSchema),
    defaultValues: { credential: '' },
  });

  if (auth.session) return <Navigate to="/dashboard" replace />;

  const beginLogin = passwordForm.handleSubmit(async (values) => {
    setError(null);
    setSubmitting(true);
    const email = values.email.trim();
    const pending = postJSON<LoginChallenge>('/auth/login', { email, password: values.password });
    passwordForm.resetField('password', { defaultValue: '' });
    try {
      const result = await pending;
      passwordForm.reset({ email: '', password: '' });
      setChallenge(result);
      setRecoveryMode(false);
    } catch (requestError) {
      setError(errorMessage(requestError));
    } finally {
      setSubmitting(false);
    }
  });

  const completeLogin = mfaForm.handleSubmit(async (values) => {
    if (!challenge) return;
    setError(null);
    setSubmitting(true);
    const payload = recoveryMode
      ? { challenge_id: challenge.challenge_id, totp_code: '', recovery_code: values.credential.trim() }
      : { challenge_id: challenge.challenge_id, totp_code: values.credential.trim(), recovery_code: '' };
    const pending = postJSON<SessionDocument>('/auth/totp/verify', payload);
    mfaForm.resetField('credential', { defaultValue: '' });
    try {
      const session = await pending;
      await auth.establishSession(session);
      const destination =
        typeof location.state === 'object' &&
        location.state !== null &&
        'from' in location.state &&
        typeof location.state.from === 'string' &&
        location.state.from.startsWith('/')
          ? location.state.from
          : '/dashboard';
      void navigate(destination, { replace: true });
    } catch (requestError) {
      setError(errorMessage(requestError));
    } finally {
      setSubmitting(false);
    }
  });

  const restart = () => {
    setChallenge(null);
    setRecoveryMode(false);
    setError(null);
    mfaForm.reset();
  };

  return (
    <main className="auth-page">
      <section className="auth-intro" aria-label="Aera Admin 安全说明">
        <div className="auth-brand-mark">A</div>
        <Typography.Title level={1}>Aera Admin</Typography.Title>
        <Typography.Paragraph>
          面向公司内部开发、运营、客服与财务人员的安全控制台。
        </Typography.Paragraph>
        <div className="auth-security-points">
          <span><LockOutlined /> 独立管理员身份</span>
          <span><SafetyCertificateOutlined /> 强制 TOTP 双因素认证</span>
          <span><KeyOutlined /> 高风险操作二次确认</span>
        </div>
      </section>

      <Card className="auth-card" variant="borderless">
        <div className="auth-card-heading">
          <Typography.Text className="auth-kicker">INTERNAL ACCESS</Typography.Text>
          <Typography.Title level={2}>{challenge ? '二次验证' : '管理员登录'}</Typography.Title>
          <Typography.Paragraph type="secondary">
            {challenge ? '密码验证已完成，请继续验证' : '使用独立于 Aera 普通用户的内部管理员凭证'}
          </Typography.Paragraph>
        </div>

        {error && <Alert className="auth-alert" type="error" showIcon message={error} />}

        {!challenge ? (
          <Form key="password-stage" layout="vertical" requiredMark={false} onFinish={() => void beginLogin()}>
            <Form.Item
              label="内部邮箱"
              validateStatus={passwordForm.formState.errors.email ? 'error' : undefined}
              help={passwordForm.formState.errors.email?.message}
            >
              <Controller
                name="email"
                control={passwordForm.control}
                render={({ field }) => (
                  <Input
                    {...field}
                    id="login-email"
                    aria-label="内部邮箱"
                    autoComplete="username"
                    prefix={<UserOutlined />}
                    placeholder="name@company.com"
                    size="large"
                  />
                )}
              />
            </Form.Item>
            <Form.Item
              label="密码"
              validateStatus={passwordForm.formState.errors.password ? 'error' : undefined}
              help={passwordForm.formState.errors.password?.message}
            >
              <Controller
                name="password"
                control={passwordForm.control}
                render={({ field }) => (
                  <Input.Password
                    {...field}
                    id="login-password"
                    aria-label="密码"
                    autoComplete="current-password"
                    prefix={<LockOutlined />}
                    placeholder="独立管理员密码"
                    size="large"
                  />
                )}
              />
            </Form.Item>
            <Button type="primary" htmlType="submit" size="large" block loading={submitting}>
              继续
            </Button>
          </Form>
        ) : (
          <Form key="mfa-stage" layout="vertical" requiredMark={false} onFinish={() => void completeLogin()}>
            <Form.Item
              label={recoveryMode ? '恢复码' : '动态验证码'}
              validateStatus={mfaForm.formState.errors.credential ? 'error' : undefined}
              help={mfaForm.formState.errors.credential?.message}
            >
              <Controller
                name="credential"
                control={mfaForm.control}
                render={({ field }) => (
                  <Input
                    {...field}
                    id="mfa-credential"
                    aria-label={recoveryMode ? '恢复码' : '动态验证码'}
                    autoComplete="one-time-code"
                    inputMode={recoveryMode ? 'text' : 'numeric'}
                    maxLength={recoveryMode ? 128 : 6}
                    prefix={<SafetyCertificateOutlined />}
                    placeholder={recoveryMode ? '输入一次性恢复码' : '6 位动态验证码'}
                    size="large"
                  />
                )}
              />
            </Form.Item>
            <Button type="primary" htmlType="submit" size="large" block loading={submitting}>
              安全登录
            </Button>
            <Divider plain>其他方式</Divider>
            <Space className="auth-secondary-actions" split={<Divider type="vertical" />}>
              <Button
                type="link"
                onClick={() => {
                  mfaForm.reset();
                  setError(null);
                  setRecoveryMode((value) => !value);
                }}
              >
                {recoveryMode ? '使用动态验证码' : '使用恢复码'}
              </Button>
              <Button type="link" onClick={restart}>返回密码登录</Button>
            </Space>
          </Form>
        )}

        <div className="auth-footer-note">
          会话凭证仅通过 HttpOnly Cookie 保存；密码、验证码和挑战值不会写入浏览器存储。
        </div>
      </Card>
    </main>
  );
}
