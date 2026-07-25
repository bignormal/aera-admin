import type { Endpoint } from 'payload'

import { buildCatalog, type CatalogAgentDocument } from '../domain/catalog'

export const catalogEndpoint: Endpoint = {
  path: '/catalog/v1/experts',
  method: 'get',
  handler: async (req) => {
    const result = await req.payload.find({
      collection: 'agent-templates',
      depth: 2,
      draft: false,
      limit: 1000,
      overrideAccess: true,
      pagination: false,
      where: { _status: { equals: 'published' } },
    })
    const requestOrigin = req.url ? new URL(req.url).origin : undefined
    const serverURL = process.env.NEXT_PUBLIC_SERVER_URL || requestOrigin || 'http://localhost:3000'

    return Response.json(buildCatalog(result.docs as CatalogAgentDocument[], serverURL))
  },
}
