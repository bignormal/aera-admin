import type { Endpoint } from 'payload'

import { createPlatformHandler } from '../platform-api/handler'

const handler = createPlatformHandler()

export const platformEndpoints: Endpoint[] = [
  { path: '/platform/v1/:operation', method: 'get', handler },
  { path: '/platform/v1/:operation', method: 'post', handler },
  { path: '/platform/v1/:operation', method: 'put', handler },
  { path: '/platform/v1/:operation', method: 'delete', handler },
]
