import path from 'node:path'

// 契约参照旧 aera-admin/internal/config/config.go 的 loadCloudAdmin：
// HTTPS origin + 绝对路径证书/密钥文件 + 稳定服务身份 + 显式 scope 集合。
const serviceIdentityPattern = /^[a-z][a-z0-9._-]{2,63}$/
const scopePattern = /^[a-z][a-z0-9_]*(?::[a-z][a-z0-9_]*)?$/
const maxScopes = 16

export type CloudAdminConfig = {
  baseURL: URL
  caFile: string
  clientCertFile: string
  clientKeyFile: string
  configured: true
  jwtIssuer: string
  jwtSigningKeyFile: string
  jwtSubject: string
  scopes: readonly string[]
  timeoutMs: number
}

export type CloudAdminConfigResult =
  | CloudAdminConfig
  | {
      configured: false
      errorCode: 'invalid_configuration' | 'missing_configuration'
    }

type CloudAdminEnvironment = Record<string, string | undefined>

function timeoutMilliseconds(value: string | undefined): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 10 || parsed > 30_000) return 5_000
  return Math.round(parsed)
}

function absoluteFile(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  if (!trimmed || !path.isAbsolute(trimmed) || path.normalize(trimmed) !== trimmed) return undefined
  return trimmed
}

function parseScopes(value: string | undefined): readonly string[] | undefined {
  const trimmed = value?.trim()
  if (!trimmed) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return undefined
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > maxScopes) return undefined
  const seen = new Set<string>()
  for (const scope of parsed) {
    if (typeof scope !== 'string' || !scopePattern.test(scope) || seen.has(scope)) return undefined
    seen.add(scope)
  }
  return Object.freeze([...seen])
}

export function getCloudAdminConfig(env: CloudAdminEnvironment): CloudAdminConfigResult {
  const rawURL = env.AGENTERA_CLOUD_ADMIN_BASE_URL?.trim()
  if (!rawURL) return { configured: false, errorCode: 'missing_configuration' }

  let baseURL: URL
  try {
    baseURL = new URL(rawURL)
  } catch {
    return { configured: false, errorCode: 'invalid_configuration' }
  }
  if (
    baseURL.protocol !== 'https:' ||
    !baseURL.host ||
    baseURL.username ||
    baseURL.password ||
    baseURL.search ||
    baseURL.hash ||
    (baseURL.pathname !== '' && baseURL.pathname !== '/')
  ) {
    return { configured: false, errorCode: 'invalid_configuration' }
  }

  const caFile = absoluteFile(env.AGENTERA_CLOUD_ADMIN_CA_FILE)
  const clientCertFile = absoluteFile(env.AGENTERA_CLOUD_ADMIN_CLIENT_CERT_FILE)
  const clientKeyFile = absoluteFile(env.AGENTERA_CLOUD_ADMIN_CLIENT_KEY_FILE)
  const jwtSigningKeyFile = absoluteFile(env.AGENTERA_CLOUD_ADMIN_JWT_SIGNING_KEY_FILE)
  const jwtIssuer = env.AGENTERA_CLOUD_ADMIN_JWT_ISSUER?.trim()
  const jwtSubject = env.AGENTERA_CLOUD_ADMIN_JWT_SUBJECT?.trim()
  const scopes = parseScopes(env.AGENTERA_CLOUD_ADMIN_SCOPES)

  if (
    !caFile ||
    !clientCertFile ||
    !clientKeyFile ||
    !jwtSigningKeyFile ||
    !jwtIssuer ||
    !serviceIdentityPattern.test(jwtIssuer) ||
    !jwtSubject ||
    !serviceIdentityPattern.test(jwtSubject) ||
    !scopes
  ) {
    return { configured: false, errorCode: 'invalid_configuration' }
  }

  return {
    baseURL,
    caFile,
    clientCertFile,
    clientKeyFile,
    configured: true,
    jwtIssuer,
    jwtSigningKeyFile,
    jwtSubject,
    scopes,
    timeoutMs: timeoutMilliseconds(env.AGENTERA_CLOUD_ADMIN_TIMEOUT_MS),
  }
}

export function readCloudAdminConfig(): CloudAdminConfigResult {
  return getCloudAdminConfig(process.env)
}
