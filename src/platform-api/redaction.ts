const sensitiveKey =
  /(?:password|secret|token(?!s(?:$|[_-]))|api[_-]?key|authorization|cookie|credential|private[_-]?key)/i
const maxDepth = 10
const maxArrayLength = 1_000

function redact(value: unknown, seen: WeakSet<object>, depth: number): unknown {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value
  if (typeof value === 'string') return value
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'undefined') return null
  if (value instanceof Date) return value.toISOString()
  if (Buffer.isBuffer(value)) return '[BINARY]'
  if (depth >= maxDepth) return '[MAX_DEPTH]'

  if (Array.isArray(value)) {
    return value.slice(0, maxArrayLength).map((item) => redact(item, seen, depth + 1))
  }

  if (typeof value === 'object') {
    if (seen.has(value)) return '[CIRCULAR]'
    seen.add(value)
    const output: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) {
      output[key] = sensitiveKey.test(key) ? '[REDACTED]' : redact(item, seen, depth + 1)
    }
    return output
  }

  return String(value)
}

export function redactExternalData(value: unknown): unknown {
  return redact(value, new WeakSet<object>(), 0)
}
