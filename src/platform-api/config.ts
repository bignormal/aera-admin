type AgenteraAPIConfigResult =
  | {
      adminKey: string
      baseURL: URL
      configured: true
      timeoutMs: number
    }
  | {
      configured: false
      errorCode: 'invalid_url' | 'missing_configuration'
    }

type PlatformAPIEnvironment = Record<string, string | undefined>

function timeoutMilliseconds(value: string | undefined): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 10 || parsed > 30_000) return 5_000
  return Math.round(parsed)
}

export function getPlatformAPIConfig(env: PlatformAPIEnvironment): AgenteraAPIConfigResult {
  const rawURL = env.AGENTERA_API_URL?.trim()
  const adminKey = env.AGENTERA_API_ADMIN_KEY?.trim()
  if (!rawURL || !adminKey) return { configured: false, errorCode: 'missing_configuration' }

  try {
    const baseURL = new URL(rawURL)
    if (
      (baseURL.protocol !== 'http:' && baseURL.protocol !== 'https:') ||
      baseURL.username ||
      baseURL.password
    ) {
      return { configured: false, errorCode: 'invalid_url' }
    }
    return {
      adminKey,
      baseURL,
      configured: true,
      timeoutMs: timeoutMilliseconds(env.AGENTERA_API_TIMEOUT_MS),
    }
  } catch {
    return { configured: false, errorCode: 'invalid_url' }
  }
}

export function readAgenteraAPIConfig(): AgenteraAPIConfigResult {
  return getPlatformAPIConfig(process.env)
}
