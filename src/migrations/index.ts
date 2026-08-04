import * as migration_20260804_034936_admin_operation_reconciliation from './20260804_034936_admin_operation_reconciliation'

export const migrations = [
  {
    up: migration_20260804_034936_admin_operation_reconciliation.up,
    down: migration_20260804_034936_admin_operation_reconciliation.down,
    name: '20260804_034936_admin_operation_reconciliation',
  },
]
