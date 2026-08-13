import { describe, expect, it } from 'vitest'

import { loginRedirectFor } from './login-redirect'

describe('login redirect routing', () => {
  it('keeps the original business target when an unauthorized response happens on login', () => {
    expect(
      loginRedirectFor({
        fullPath: '/login/pwd-login?redirect=/publishing',
        name: 'login',
        query: { redirect: '/publishing' },
      }),
    ).toBe('/publishing')
  })

  it('uses the protected route and honors an explicit override', () => {
    const route = { fullPath: '/publishing?tab=official', name: 'publishing', query: {} }

    expect(loginRedirectFor(route)).toBe('/publishing?tab=official')
    expect(loginRedirectFor(route, '/users')).toBe('/users')
  })
})
