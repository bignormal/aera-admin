export type FieldErrors = Record<string, string>;

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly fieldErrors?: FieldErrors,
    public readonly responseBody?: unknown
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

type ApiRequestOptions = Omit<RequestInit, 'body'> & {
  body?: BodyInit | object;
};

type PayloadErrorBody = {
  error?: {
    code?: string;
    message?: string;
  };
  message?: string;
  errors?: Array<{
    message?: string;
    field?: string;
    data?: {
      field?: string;
      path?: string;
      errors?: Array<{ field?: string; path?: string; message?: string }>;
    };
  }>;
};

let unauthorizedHandler: (() => void) | undefined;

export function setUnauthorizedHandler(handler: (() => void) | undefined) {
  unauthorizedHandler = handler;
}

function getFieldErrors(body: PayloadErrorBody): FieldErrors | undefined {
  const entries = (body.errors || []).flatMap(error => {
    const nested = error.data?.errors || [];

    if (nested.length) {
      return nested.flatMap(item => {
        const field = item.field || item.path;

        return field && item.message ? [[field, item.message] as const] : [];
      });
    }

    const field = error.field || error.data?.field || error.data?.path;

    return field && error.message ? [[field, error.message] as const] : [];
  });

  return entries.length ? Object.fromEntries(entries) : undefined;
}

async function readBody(response: Response): Promise<unknown> {
  if (response.status === 204) return undefined;

  const text = await response.text();
  if (!text) return undefined;

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export async function apiRequest<T>(path: string, options: ApiRequestOptions = {}): Promise<T> {
  const headers = new Headers(options.headers);
  let body = options.body as BodyInit | undefined;

  if (body && !(body instanceof FormData) && typeof body !== 'string') {
    headers.set('content-type', 'application/json');
    body = JSON.stringify(body);
  }

  let response: Response;

  try {
    response = await fetch(`/api${path}`, {
      ...options,
      body,
      credentials: 'include',
      headers
    });
  } catch {
    throw new ApiError(0, '网络连接失败，请稍后重试');
  }

  const responseBody = await readBody(response);
  if (response.ok) return responseBody as T;

  const errorBody = responseBody && typeof responseBody === 'object' ? (responseBody as PayloadErrorBody) : {};
  const message =
    errorBody.message || errorBody.error?.message || errorBody.errors?.[0]?.message || `请求失败 (${response.status})`;

  if (response.status === 401) unauthorizedHandler?.();

  throw new ApiError(response.status, message, getFieldErrors(errorBody), responseBody);
}
