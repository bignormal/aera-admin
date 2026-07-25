import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { platformOperations } from '../../src/platform-api/operations'

// 兼容迁移前后的上游仓名：本工作区为 aera-api，旧工作区为 agentera-claw-api。
const upstreamRoot = ['../aera-api', '../agentera-claw-api']
  .map((dir) => resolve(process.cwd(), dir))
  .find((dir) => existsSync(`${dir}/backend/internal/server/routes/admin.go`))

const routeFiles = ['admin.go', 'payment.go'].map((file) =>
  resolve(`${upstreamRoot}/backend/internal/server/routes/${file}`),
)

type RouteSignature = `${'DELETE' | 'GET' | 'POST' | 'PUT'} ${string}`

function joinRoute(base: string, suffix: string): string {
  const joined = `${base}/${suffix}`.replace(/\/{2,}/g, '/')
  return joined.length > 1 ? joined.replace(/\/$/, '') : joined
}

function registeredAdminRoutes(source: string): Set<RouteSignature> {
  const groups = new Map<string, string>([['v1', '']])
  const routes = new Set<RouteSignature>()

  for (const line of source.split('\n')) {
    const group = line.match(/\b(\w+)\s*:=\s*(\w+)\.Group\("([^"]*)"\)/)
    if (group) {
      const [, name, parent, path] = group
      const parentPath = groups.get(parent)
      if (parentPath !== undefined) groups.set(name, joinRoute(parentPath, path))
    }

    const route = line.match(/\b(\w+)\.(GET|POST|PUT|DELETE)\("([^"]*)"/)
    if (route) {
      const [, groupName, method, path] = route
      const groupPath = groups.get(groupName)
      if (groupPath) routes.add(`${method} ${joinRoute(groupPath, path)}` as RouteSignature)
    }
  }

  return routes
}

describe('AgentEra API operation registry contract', () => {
  it('maps every allowlisted BFF operation to an existing Go admin route', () => {
    const registered = new Set(
      routeFiles.flatMap((file) => [...registeredAdminRoutes(readFileSync(file, 'utf8'))]),
    )
    const missing = Object.entries(platformOperations).flatMap(([operation, definition]) => {
      const params = Object.fromEntries((definition.params || []).map(name => [name, `:${name}`]))
      const signature = `${definition.method} ${definition.upstreamPath(params)}` as RouteSignature
      return registered.has(signature) ? [] : [{ operation, signature }]
    })

    expect(missing).toEqual([])
  })

  it('keeps all upstream operations inside the authenticated admin namespace', () => {
    for (const definition of Object.values(platformOperations)) {
      const params = Object.fromEntries((definition.params || []).map(name => [name, `:${name}`]))
      expect(definition.upstreamPath(params)).toMatch(/^\/admin(?:\/|$)/)
    }
  })
})
