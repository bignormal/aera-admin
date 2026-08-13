type LoginRedirectRoute = {
  fullPath: string
  name?: unknown
  query?: Record<string, unknown>
}

export function loginRedirectFor(route: LoginRedirectRoute, explicit?: string): string {
  if (explicit) return explicit
  if (route.name === 'login') {
    const redirect = route.query?.redirect
    return typeof redirect === 'string' && redirect.startsWith('/') ? redirect : '/'
  }
  return route.fullPath
}
