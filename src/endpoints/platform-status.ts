import { randomUUID } from 'node:crypto'
import type { Endpoint, Payload } from 'payload'

import { hasCapability } from '../access/capabilities'
import { probeAgenteraAPI } from '../platform-api/client'
import { probeCloudAdmin } from '../platform-api/cloud/client'
import type {
  PlatformFailure,
  PlatformStatusData,
  PlatformSuccess,
  ServiceProbe,
} from '../platform-api/types'

function requestID(headers?: Headers): string {
  return headers?.get('x-request-id')?.trim() || randomUUID()
}

function failure(requestId: string, status: number, code: string, message: string): Response {
  const body: PlatformFailure = { error: { code, message }, requestId }
  return Response.json(body, { status })
}

async function persistProbeStatus(payload: Payload, probe: ServiceProbe): Promise<void> {
  try {
    const existing = await payload.find({
      collection: 'integration-settings',
      limit: 1,
      overrideAccess: true,
      where: { service: { equals: 'agentera_api' } },
    })
    const data = {
      enabled: probe.status !== 'not_configured',
      healthStatus: probe.status,
      lastCheckedAt: probe.checkedAt,
      lastErrorCode: probe.errorCode,
      service: 'agentera_api' as const,
    }

    if (existing.docs[0]) {
      await payload.update({
        collection: 'integration-settings',
        data,
        id: existing.docs[0].id,
        overrideAccess: true,
      })
    } else {
      await payload.create({
        collection: 'integration-settings',
        data,
        overrideAccess: true,
      })
    }
  } catch {
    // Health responses remain available even when status persistence is temporarily unavailable.
  }
}

export const platformStatusEndpoint: Endpoint = {
  path: '/platform/v1/status',
  method: 'get',
  handler: async (req) => {
    const currentRequestID = requestID(req.headers)
    if (!req.user) {
      return failure(currentRequestID, 401, 'UNAUTHENTICATED', '请先登录管理后台。')
    }
    if (!hasCapability(req.user.role, 'dashboard:read')) {
      return failure(currentRequestID, 403, 'FORBIDDEN', '当前角色无权查看平台状态。')
    }

    const [agenteraAPI, aeraCloud] = await Promise.all([
      probeAgenteraAPI(currentRequestID),
      probeCloudAdmin(currentRequestID),
    ])
    await persistProbeStatus(req.payload, agenteraAPI)

    const body: PlatformSuccess<PlatformStatusData, { generatedAt: string }> = {
      data: {
        aeraCloud,
        agenteraAPI,
        payload: { status: 'healthy' },
      },
      meta: { generatedAt: new Date().toISOString() },
      requestId: currentRequestID,
    }
    return Response.json(body)
  },
}
