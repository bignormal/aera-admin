import type { CollectionConfig } from 'payload'

// Internal-only SQLite coordination records. These are never exposed through
// the Admin REST API or UI; all access is performed with overrideAccess by the
// Cloud mutation handler and its reconciliation coordinator.
export const CloudOperationReceipts: CollectionConfig = {
  slug: 'cloud-operation-receipts',
  admin: { hidden: true },
  access: {
    create: () => false,
    delete: () => false,
    read: () => false,
    update: () => false,
  },
  fields: [
    { name: 'operationId', type: 'text', index: true, required: true, unique: true },
    { name: 'operationKey', type: 'text', index: true, required: true },
    { name: 'requestId', type: 'text', index: true, required: true },
    { name: 'actorAdminId', type: 'text', index: true, required: true },
    { name: 'actorRole', type: 'text', required: true },
    { name: 'localActorId', type: 'text', required: true },
    { name: 'localActorRole', type: 'text', required: true },
    { name: 'capability', type: 'text', required: true },
    { name: 'request', type: 'json', required: true },
    { name: 'rollbackRequestId', type: 'text' },
    {
      name: 'status',
      type: 'select',
      defaultValue: 'pending',
      index: true,
      options: [
        { label: 'Pending', value: 'pending' },
        { label: 'Reconciling', value: 'reconciling' },
        { label: 'Succeeded', value: 'succeeded' },
        { label: 'Failed', value: 'failed' },
        { label: 'Conflict', value: 'conflict' },
      ],
      required: true,
    },
    { name: 'administrativeRevision', type: 'number', min: 1 },
    {
      name: 'cloudStatus',
      type: 'select',
      options: ['queued', 'executing', 'succeeded', 'failed', 'conflict'],
    },
    { name: 'cloudUpdatedAt', type: 'date' },
    { name: 'errorCode', type: 'text' },
    { name: 'lastErrorCode', type: 'text' },
    { name: 'definitiveFailure', type: 'checkbox', defaultValue: false, required: true },
    { name: 'attemptCount', type: 'number', defaultValue: 0, min: 0, required: true },
    { name: 'lastAttemptAt', type: 'date' },
    { name: 'nextAttemptAt', type: 'date', index: true },
    { name: 'leaseOwner', type: 'text', index: true },
    { name: 'leaseExpiresAt', type: 'date', index: true },
    { name: 'auditCompletedAt', type: 'date' },
    { name: 'rollbackCompletedAt', type: 'date' },
    { name: 'upstreamRequestId', type: 'text', index: true },
  ],
}
