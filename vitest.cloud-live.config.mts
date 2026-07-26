import { defineConfig } from 'vitest/config'

const requiredEnvironment = [
  'AGENTERA_CLOUD_ADMIN_BASE_URL',
  'AGENTERA_CLOUD_ADMIN_CA_FILE',
  'AGENTERA_CLOUD_ADMIN_CLIENT_CERT_FILE',
  'AGENTERA_CLOUD_ADMIN_CLIENT_KEY_FILE',
  'AGENTERA_CLOUD_ADMIN_JWT_SIGNING_KEY_FILE',
  'AGENTERA_CLOUD_ADMIN_JWT_ISSUER',
  'AGENTERA_CLOUD_ADMIN_JWT_SUBJECT',
  'AGENTERA_CLOUD_ADMIN_SCOPES',
] as const

const missingEnvironment = requiredEnvironment.filter((key) => !process.env[key])
if (missingEnvironment.length > 0) {
  throw new Error(`Live Cloud tests require: ${missingEnvironment.join(', ')}`)
}

export default defineConfig({
  test: {
    environment: 'node',
    fileParallelism: false,
    include: ['tests/live/cloud-admin.live.spec.ts'],
    pool: 'forks',
    sequence: { concurrent: false },
  },
})
