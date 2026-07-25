const secretField = /(secret|token|password|api[_-]?key|private[_-]?key|ciphertext)/i

export function normalizeMoney(value: string | number): string {
  if (typeof value === 'string') {
    const normalized = value.trim()
    if (!/^-?\d+(?:\.\d+)?$/.test(normalized)) throw new TypeError('Invalid money value')
    return normalized
  }
  if (!Number.isFinite(value)) throw new TypeError('Invalid money value')
  return String(value)
}

function maskedSecret(value: unknown): { configured: boolean; masked: string } {
  if (value === null || value === undefined || value === '') return { configured: false, masked: '' }
  const text = String(value)
  return { configured: true, masked: `****${text.slice(-4)}` }
}

export function sanitizePaymentProvider<T>(provider: T): T {
  if (Array.isArray(provider)) return provider.map(item => sanitizePaymentProvider(item)) as T
  if (!provider || typeof provider !== 'object') return provider

  return Object.fromEntries(
    Object.entries(provider).map(([key, value]) => [
      key,
      secretField.test(key) ? maskedSecret(value) : sanitizePaymentProvider(value),
    ]),
  ) as T
}

export function normalizePagination<T>(value: unknown): {
  data: T[]
  meta: { page: number; pageSize: number; total: number }
} {
  const source =
    value && typeof value === 'object' && 'data' in value
      ? (value as { data?: unknown }).data
      : value
  if (Array.isArray(source)) {
    return { data: source as T[], meta: { page: 1, pageSize: source.length, total: source.length } }
  }
  if (!source || typeof source !== 'object') {
    return { data: [], meta: { page: 1, pageSize: 0, total: 0 } }
  }
  const page = source as {
    docs?: T[]
    items?: T[]
    page?: number
    page_size?: number
    pageSize?: number
    total?: number
    totalDocs?: number
  }
  const data = page.items || page.docs || []
  return {
    data,
    meta: {
      page: page.page || 1,
      pageSize: page.page_size || page.pageSize || data.length,
      total: page.total ?? page.totalDocs ?? data.length,
    },
  }
}
