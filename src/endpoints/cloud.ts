import type { Endpoint } from 'payload'

import { createCloudHandler } from '../platform-api/cloud/handler'

const handler = createCloudHandler()

export const cloudEndpoints: Endpoint[] = [
  { path: '/cloud/v1/:operation', method: 'get', handler },
  { path: '/cloud/v1/:operation', method: 'post', handler },
  { path: '/cloud/v1/:operation', method: 'patch', handler },
]
