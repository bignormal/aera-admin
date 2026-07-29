import 'dotenv/config'

import config from '@payload-config'
import { getPayload } from 'payload'

import { seedCatalog } from './seed/seedCatalog'

const payload = await getPayload({ config })
const result = await seedCatalog(payload)
payload.logger.info(result, 'Aera catalog seed complete')
process.exit(0)
