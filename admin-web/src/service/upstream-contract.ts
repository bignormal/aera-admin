import type { PayloadPage } from './resources';

export class ContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContractError';
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function asResourceRecord(value: unknown): Record<string, unknown> {
  if (
    !record(value) ||
    !['number', 'string'].includes(typeof value.id) ||
    (typeof value.id === 'string' && value.id.trim() === '')
  ) {
    throw new ContractError('AgentEra API 资源缺少合法 id');
  }
  return value;
}

export function asUpstreamRecord(value: unknown): Record<string, unknown> {
  if (!record(value)) {
    throw new ContractError('AgentEra API 对象格式不合法');
  }
  return value;
}

export function unwrapUpstream(value: unknown): unknown {
  if (!record(value) || typeof value.code !== 'number' || !('data' in value)) {
    throw new ContractError('AgentEra API 响应格式不合法');
  }
  if (value.code !== 0) {
    throw new ContractError(typeof value.message === 'string' ? value.message : 'AgentEra API 返回异常');
  }
  return value.data;
}

export function normalizeUpstreamPage<T>(
  value: unknown,
  query: { limit: number; page: number },
  parseItem: (item: unknown) => T
): PayloadPage<T> {
  if (!record(value) || !Array.isArray(value.items)) {
    throw new ContractError('AgentEra API 分页格式不合法');
  }
  const integer = (source: unknown, fallback: number, minimum: number) => {
    const resolved = source === undefined ? fallback : source;
    if (typeof resolved !== 'number' || !Number.isInteger(resolved) || resolved < minimum) {
      throw new ContractError('AgentEra API 分页元数据不合法');
    }
    return resolved;
  };
  const page = integer(value.page, query.page, 1);
  const limit = integer(value.page_size, query.limit, 1);
  const totalDocs = integer(value.total, value.items.length, 0);
  const totalPages = integer(value.pages, Math.max(1, Math.ceil(totalDocs / limit)), 0);
  return {
    docs: value.items.map(parseItem),
    hasNextPage: page < totalPages,
    hasPrevPage: page > 1,
    limit,
    page,
    totalDocs,
    totalPages
  };
}

export function normalizeUpstreamArray<T>(
  value: unknown,
  query: { limit: number; page: number },
  parseItem: (item: unknown) => T
): PayloadPage<T> {
  if (!Array.isArray(value)) {
    throw new ContractError('AgentEra API 数组格式不合法');
  }
  return {
    docs: value.map(parseItem),
    hasNextPage: false,
    hasPrevPage: false,
    limit: query.limit,
    page: query.page,
    totalDocs: value.length,
    totalPages: 1
  };
}
