import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('production same-origin routing', () => {
  it('serves Soybean under /admin and preserves Payload /api paths', async () => {
    const nginx = await readFile('deploy/nginx/agentera-admin.conf', 'utf8')

    expect(nginx).toContain('upstream payload_backend')
    expect(nginx).toContain('server 127.0.0.1:3100;')
    expect(nginx).toContain('location ^~ /api/')
    expect(nginx).toContain('proxy_pass http://payload_backend;')
    expect(nginx).not.toContain('proxy_pass http://payload_backend/;')
    expect(nginx).toContain('location /admin/')
    expect(nginx).toContain('try_files $uri $uri/ /admin/index.html;')
    expect(nginx).not.toMatch(/location\s+\/admin\/\s*\{[^}]*proxy_pass/s)
  })

  it('sets bounded uploads, forwarding headers and safe static caching', async () => {
    const nginx = await readFile('deploy/nginx/agentera-admin.conf', 'utf8')

    expect(nginx).toMatch(/client_max_body_size\s+\d+[mM];/)
    expect(nginx).toContain('proxy_set_header X-Request-ID $request_id;')
    expect(nginx).toContain('proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;')
    expect(nginx).toContain('proxy_set_header X-Forwarded-Proto $scheme;')
    expect(nginx).toMatch(/location \^~ \/admin\/assets\/[\s\S]*immutable/)
    expect(nginx).toMatch(/location = \/admin\/index\.html[\s\S]*no-store/)
    expect(nginx).not.toContain('/Users/')
  })

  it('documents required integration variables and a single production build command', async () => {
    const [env, packageJSON, runbook] = await Promise.all([
      readFile('.env.example', 'utf8'),
      readFile('package.json', 'utf8'),
      readFile('docs/operations/platform-admin-runbook.md', 'utf8'),
    ])
    const scripts = (JSON.parse(packageJSON) as { scripts: Record<string, string> }).scripts

    expect(env).toContain('ADMIN_WEB_URL=')
    expect(env).toContain('AGENTERA_API_URL=')
    expect(env).toContain('AGENTERA_API_ADMIN_KEY=')
    expect(scripts['build:platform']).toBe('pnpm run build && pnpm run build:admin')
    expect(runbook).toMatch(/充值站/)
    expect(runbook).toMatch(/回滚/)
    expect(runbook).not.toMatch(/agentera-test-password|replace-with-a-long-random-secret/)
  })
})
