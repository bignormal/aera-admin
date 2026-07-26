import { defineConfig } from 'vitest/config'

if (!process.env.AGENTERA_API_URL || !process.env.AGENTERA_API_ADMIN_KEY) {
  throw new Error('Live platform tests require AGENTERA_API_URL and AGENTERA_API_ADMIN_KEY')
}

export default defineConfig({
  test: {
    environment: 'node',
    fileParallelism: false,
    include: ['tests/live/platform-read.live.spec.ts'],
    pool: 'forks',
    sequence: { concurrent: false },
  },
})
