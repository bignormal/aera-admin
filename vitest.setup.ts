// Any setup scripts you might need go here

// Load .env files
import 'dotenv/config'

import { mkdirSync } from 'node:fs'

mkdirSync('.tmp', { recursive: true })
process.env.DATABASE_URL = `file:./.tmp/vitest-${process.pid}.db`
