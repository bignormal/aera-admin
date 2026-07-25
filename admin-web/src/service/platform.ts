import { apiRequest } from './http';
import { ApiError } from './http';

export type ServiceProbe = {
  checkedAt: string;
  errorCode?: string;
  latencyMs: number;
  status: 'healthy' | 'not_configured' | 'unavailable';
};

export type PlatformStatus = {
  data: {
    aeraCloud?: ServiceProbe;
    agenteraAPI: ServiceProbe;
    payload: { status: 'healthy' };
  };
  meta: { generatedAt: string };
  requestId: string;
};

export function getPlatformStatus(signal?: AbortSignal): Promise<PlatformStatus> {
  return apiRequest('/platform/v1/status', { signal });
}

export type PlatformDomainReadiness = {
  errorCode?: string;
  key: string;
  label: string;
  latencyMs: number;
  status: 'healthy' | 'unavailable';
};

export type PlatformReadiness = {
  data: { domains: PlatformDomainReadiness[] };
  meta: { generatedAt: string };
  requestId: string;
};

export function getPlatformReadiness(signal?: AbortSignal): Promise<PlatformReadiness> {
  return apiRequest('/platform/v1/readiness', { signal });
}

export type PlatformMethod = 'DELETE' | 'GET' | 'POST' | 'PUT';

export type PlatformCallOptions = {
  body?: unknown;
  method?: PlatformMethod;
  params?: Record<string, boolean | number | string | null | undefined>;
  signal?: AbortSignal;
};

export type PlatformEnvelope<T> = {
  data: T;
  meta: Record<string, unknown>;
  requestId: string;
};

type PlatformFailureBody = {
  error?: { code?: string; message?: string };
  requestId?: string;
};

export type PlatformErrorKind = 'backend-unavailable' | 'forbidden' | 'request-failed' | 'unauthenticated';

export class PlatformServiceError extends Error {
  constructor(
    public readonly kind: PlatformErrorKind,
    public readonly status: number,
    message: string,
    public readonly requestId?: string,
    public readonly code?: string
  ) {
    super(message);
    this.name = 'PlatformServiceError';
  }
}

function errorKind(status: number): PlatformErrorKind {
  if (status === 401) return 'unauthenticated';
  if (status === 403) return 'forbidden';
  if (status === 0 || status >= 500) return 'backend-unavailable';
  return 'request-failed';
}

function platformError(error: unknown): PlatformServiceError {
  if (!(error instanceof ApiError)) {
    return new PlatformServiceError('request-failed', 0, '平台管理请求失败');
  }
  const body =
    error.responseBody && typeof error.responseBody === 'object' ? (error.responseBody as PlatformFailureBody) : {};
  return new PlatformServiceError(
    errorKind(error.status),
    error.status,
    body.error?.message || error.message,
    body.requestId,
    body.error?.code
  );
}

export async function callPlatform<T>(
  operation: string,
  options: PlatformCallOptions = {}
): Promise<PlatformEnvelope<T>> {
  const params = new URLSearchParams();
  Object.entries(options.params || {}).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') params.set(key, String(value));
  });
  const suffix = params.size ? `?${params.toString()}` : '';

  try {
    return await apiRequest<PlatformEnvelope<T>>(`/platform/v1/${encodeURIComponent(operation)}${suffix}`, {
      method: options.method || 'GET',
      body: options.body as object | undefined,
      signal: options.signal
    });
  } catch (error) {
    throw platformError(error);
  }
}
