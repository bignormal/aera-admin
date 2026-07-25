import { ApiError, apiRequest } from './http';

// 管理员安全能力：TOTP 绑定与高危操作 StepUp 二次验证。
export type StepUpStatus = {
  stepUpVerifiedAt?: string;
  totpEnabled: boolean;
  windowSeconds: number;
};

export type TotpEnrollment = {
  otpauthURL: string;
  secret: string;
};

type SecurityEnvelope<T> = {
  data: T;
  requestId: string;
};

export class SecurityServiceError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code?: string
  ) {
    super(message);
    this.name = 'SecurityServiceError';
  }
}

function securityError(error: unknown): SecurityServiceError {
  if (!(error instanceof ApiError)) return new SecurityServiceError(0, '安全请求失败');
  const body =
    error.responseBody && typeof error.responseBody === 'object'
      ? (error.responseBody as { error?: { code?: string; message?: string } })
      : {};
  return new SecurityServiceError(error.status, body.error?.message || error.message, body.error?.code);
}

export async function getStepUpStatus(signal?: AbortSignal): Promise<StepUpStatus> {
  try {
    const result = await apiRequest<SecurityEnvelope<StepUpStatus>>('/security/step-up/status', { signal });
    return result.data;
  } catch (error) {
    throw securityError(error);
  }
}

export async function enrollTotp(): Promise<TotpEnrollment> {
  try {
    const result = await apiRequest<SecurityEnvelope<TotpEnrollment>>('/security/totp/enroll', { method: 'POST' });
    return result.data;
  } catch (error) {
    throw securityError(error);
  }
}

export async function confirmTotp(code: string): Promise<{ totpEnabledAt: string }> {
  try {
    const result = await apiRequest<SecurityEnvelope<{ totpEnabledAt: string }>>('/security/totp/confirm', {
      method: 'POST',
      body: { code }
    });
    return result.data;
  } catch (error) {
    throw securityError(error);
  }
}

export async function verifyStepUp(code: string): Promise<{ expiresInSeconds: number; verifiedAt: string }> {
  try {
    const result = await apiRequest<SecurityEnvelope<{ expiresInSeconds: number; verifiedAt: string }>>(
      '/security/step-up',
      { method: 'POST', body: { code } }
    );
    return result.data;
  } catch (error) {
    throw securityError(error);
  }
}
