import * as migration_20260727_000000_admin_initial_schema from './20260727_000000_admin_initial_schema'
import * as migration_20260804_034936_admin_operation_reconciliation from './20260804_034936_admin_operation_reconciliation'
import * as migration_20260812_041829 from './20260812_041829'
import * as migration_20260812_050732_skill_distribution_class from './20260812_050732_skill_distribution_class'
import * as migration_20260812_052605_plugin_delivery_status from './20260812_052605_plugin_delivery_status'

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
  {
    up: migration_20260812_041829.up,
    down: migration_20260812_041829.down,
    name: '20260812_041829',
  },
  {
    up: migration_20260812_050732_skill_distribution_class.up,
    down: migration_20260812_050732_skill_distribution_class.down,
    name: '20260812_050732_skill_distribution_class',
  },
  {
    up: migration_20260812_052605_plugin_delivery_status.up,
    down: migration_20260812_052605_plugin_delivery_status.down,
    name: '20260812_052605_plugin_delivery_status',
  },
]
