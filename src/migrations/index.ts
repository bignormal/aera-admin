import * as migration_20260727_000000_admin_initial_schema from './20260727_000000_admin_initial_schema'
import * as migration_20260804_034936_admin_operation_reconciliation from './20260804_034936_admin_operation_reconciliation'

export const migrations = [
  {
    up: migration_20260727_000000_admin_initial_schema.up,
    down: migration_20260727_000000_admin_initial_schema.down,
    name: '20260727_000000_admin_initial_schema',
  },
  {
    up: migration_20260804_034936_admin_operation_reconciliation.up,
    down: migration_20260804_034936_admin_operation_reconciliation.down,
    name: '20260804_034936_admin_operation_reconciliation',
  },
]
