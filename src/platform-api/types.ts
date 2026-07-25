export type PlatformSuccess<T, M extends Record<string, unknown> = Record<string, never>> = {
  data: T
  meta: M
  requestId: string
}

export type PlatformFailure = {
  error: {
    code: string
    message: string
  }
  requestId: string
}

export type ServiceHealth = 'healthy' | 'not_configured' | 'unavailable'

export type ServiceProbe = {
  checkedAt: string
  errorCode?: string
  latencyMs: number
  status: ServiceHealth
}

export type PlatformStatusData = {
  aeraCloud: ServiceProbe
  agenteraAPI: ServiceProbe
  payload: {
    status: 'healthy'
  }
}
