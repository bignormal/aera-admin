import { ApiError, apiRequest } from './http';

// 云端管理操作统一入口：走 Payload BFF 的 /api/cloud/v1/:operation，
// 上游为 aera-cloud 内部管理 API（mTLS + 服务 JWT 由 BFF 持有）。
export type CloudMethod = 'GET' | 'PATCH' | 'POST';

export type CloudCallOptions = {
  body?: unknown;
  method?: CloudMethod;
  params?: Record<string, boolean | number | string | null | undefined>;
  signal?: AbortSignal;
};

export type CloudEnvelope<T> = {
  data: T;
  meta: Record<string, unknown>;
  requestId: string;
};

type CloudFailureBody = {
  error?: { code?: string; message?: string };
  requestId?: string;
};

export type CloudErrorKind =
  | 'backend-unavailable'
  | 'forbidden'
  | 'request-failed'
  | 'step-up-required'
  | 'unauthenticated';

export class CloudServiceError extends Error {
  constructor(
    public readonly kind: CloudErrorKind,
    public readonly status: number,
    message: string,
    public readonly requestId?: string,
    public readonly code?: string
  ) {
    super(message);
    this.name = 'CloudServiceError';
  }
}

function errorKind(status: number): CloudErrorKind {
  if (status === 401) return 'unauthenticated';
  if (status === 403) return 'forbidden';
  if (status === 428) return 'step-up-required';
  if (status === 0 || status >= 500) return 'backend-unavailable';
  return 'request-failed';
}

function cloudError(error: unknown): CloudServiceError {
  if (!(error instanceof ApiError)) {
    return new CloudServiceError('request-failed', 0, '云端管理请求失败');
  }
  const body =
    error.responseBody && typeof error.responseBody === 'object' ? (error.responseBody as CloudFailureBody) : {};
  return new CloudServiceError(
    errorKind(error.status),
    error.status,
    body.error?.message || error.message,
    body.requestId,
    body.error?.code
  );
}

export async function callCloud<T>(operation: string, options: CloudCallOptions = {}): Promise<CloudEnvelope<T>> {
  const params = new URLSearchParams();
  Object.entries(options.params || {}).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') params.set(key, String(value));
  });
  const suffix = params.size ? `?${params.toString()}` : '';

  try {
    return await apiRequest<CloudEnvelope<T>>(`/cloud/v1/${encodeURIComponent(operation)}${suffix}`, {
      method: options.method || 'GET',
      body: options.body as object | undefined,
      signal: options.signal
    });
  } catch (error) {
    throw cloudError(error);
  }
}
