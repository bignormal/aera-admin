import type { PayloadPage, ResourceID, ResourceQuery } from './resources';
import { listResources } from './resources';

export type AuditLog = {
  action: string;
  actorEmail?: string;
  errorCode?: string;
  id: ResourceID;
  occurredAt: string;
  outcome: 'failed' | 'succeeded';
  requestId: string;
  resourceName?: string;
  resourceType: string;
  [key: string]: unknown;
};

export function listAuditLogs(query: ResourceQuery, signal?: AbortSignal): Promise<PayloadPage<AuditLog>> {
  return listResources<AuditLog>('audit-logs', query, signal, false, 'action');
}
