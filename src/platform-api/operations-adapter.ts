export type DiagnosticSummary = {
  requestId: string
  occurredAt: string
  model?: string
  channel?: string
  status: string
  latencyMs?: number
  errorCode?: string
  errorSummary?: string
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function safeError(value: unknown): string | undefined {
  const message = text(value)
  if (!message) return undefined
  return message
    .replace(/\b(token|secret|password|authorization|cookie)\s*[=:]\s*\S+/gi, '[REDACTED]')
    .slice(0, 500)
}

export function sanitizeDiagnostic(value: unknown): DiagnosticSummary {
  const source = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  const latency = source.latency_ms ?? source.latencyMs
  return {
    requestId: text(source.request_id ?? source.requestId) || '',
    occurredAt: text(source.occurred_at ?? source.created_at ?? source.occurredAt) || '',
    ...(text(source.model) ? { model: text(source.model) } : {}),
    ...(text(source.channel) ? { channel: text(source.channel) } : {}),
    status: text(source.status) || 'unknown',
    ...(typeof latency === 'number' && Number.isFinite(latency) ? { latencyMs: latency } : {}),
    ...(text(source.error_code ?? source.errorCode)
      ? { errorCode: text(source.error_code ?? source.errorCode) }
      : {}),
    ...(safeError(source.error_message ?? source.error_summary ?? source.errorSummary)
      ? { errorSummary: safeError(source.error_message ?? source.error_summary ?? source.errorSummary) }
      : {}),
  }
}
