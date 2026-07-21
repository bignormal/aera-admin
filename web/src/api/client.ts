import type { APIErrorDocument } from './contracts';

const apiRoot = '/api/v1';
const idempotencyKeyPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/;
let csrfToken: string | null = null;
let unauthorizedHandler: (() => void) | null = null;

export class APIError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryAfterSeconds: number | null;

  constructor(status: number, code: string, message: string, retryAfterSeconds: number | null = null) {
    super(message);
    this.name = 'APIError';
    this.status = status;
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export function setSessionCSRF(value: string | null): void {
  csrfToken = value && value.length <= 512 ? value : null;
}

export function setUnauthorizedHandler(handler: (() => void) | null): () => void {
  unauthorizedHandler = handler;
  return () => {
    if (unauthorizedHandler === handler) unauthorizedHandler = null;
  };
}

function safePath(path: string): string {
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\')) {
    throw new Error('API path must be same-origin');
  }
  return `${apiRoot}${path}`;
}

function isUnsafeMethod(method: string): boolean {
  return method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS';
}

function retryAfter(response: Response): number | null {
  const raw = response.headers.get('Retry-After');
  if (!raw || !/^\d{1,4}$/.test(raw)) return null;
  const seconds = Number(raw);
  return Number.isSafeInteger(seconds) ? Math.min(Math.max(seconds, 1), 900) : null;
}

async function toAPIError(response: Response): Promise<APIError> {
  let document: APIErrorDocument = {};
  try {
    document = (await response.json()) as APIErrorDocument;
  } catch {
    // Deliberately return a generic message for non-JSON upstream failures.
  }
  return new APIError(
    response.status,
    document.error?.code ?? 'REQUEST_FAILED',
    document.error?.message ?? '请求未能完成，请稍后重试',
    retryAfter(response),
  );
}

export async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = (init.method ?? 'GET').toUpperCase();
  const headers = new Headers(init.headers);
  headers.set('Accept', 'application/json');
  if (init.body !== undefined && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  if (isUnsafeMethod(method) && csrfToken) {
    headers.set('X-CSRF-Token', csrfToken);
  }

  const response = await fetch(safePath(path), {
    ...init,
    method,
    headers,
    credentials: 'same-origin',
    cache: 'no-store',
    redirect: 'error',
  });
  if (!response.ok) {
    const error = await toAPIError(response);
    if (error.status === 401 && error.code === 'AUTH_REQUIRED') unauthorizedHandler?.();
    throw error;
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export function postJSON<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, { method: 'POST', body: JSON.stringify(body) });
}

export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

export async function postIdempotentJSON<T>(
  path: string,
  body: unknown,
  idempotencyKey: string,
): Promise<T> {
  if (!idempotencyKeyPattern.test(idempotencyKey)) throw new Error('Invalid idempotency key');
  return request<T>(path, {
    method: 'POST',
    headers: { 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify(body),
  });
}

export function putJSON<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, { method: 'PUT', body: JSON.stringify(body) });
}
