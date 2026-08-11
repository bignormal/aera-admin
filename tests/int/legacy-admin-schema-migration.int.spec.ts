import { sql } from '@payloadcms/db-sqlite'
import { getPayload } from 'payload'
import { expect, it } from 'vitest'

import { migrations } from '../../src/migrations'

it('bootstraps the complete production schema from the legacy pushed SQLite database', async () => {
  process.env.DATABASE_URL = `file:./.tmp/legacy-schema-${process.pid}.db`
  process.env.PAYLOAD_SECRET = 'aera-admin-legacy-schema-test-only'
  const { default: config } = await import('../../src/payload.config')
  const payload = await getPayload({ config })
  const db = payload.db.drizzle

  try {
    // The first internal-beta database was created by schema push and has no
    // Payload migration ledger. Preserve its one durable receipt table and
    // remove every other schema table to reproduce that exact legacy state.
    await db.run(sql`PRAGMA foreign_keys = OFF;`)
    const initialTables = await db.run(sql`
      SELECT \`name\`
      FROM \`sqlite_master\`
      WHERE \`type\` = 'table' AND \`name\` NOT LIKE 'sqlite_%';
    `)
    for (const row of initialTables.rows) {
      const table = String(row.name)
      if (table === 'cloud_operation_receipts') continue
      expect(table).toMatch(/^[a-z0-9_]+$/u)
      await db.run(sql.raw(`DROP TABLE \`${table}\`;`))
    }
    await db.run(sql`
      INSERT INTO \`cloud_operation_receipts\`
        (
          \`operation_id\`, \`operation_key\`, \`request_id\`, \`actor_admin_id\`,
          \`actor_role\`, \`local_actor_id\`, \`local_actor_role\`, \`capability\`, \`request\`
        )
      VALUES
        (
          '00000000-0000-4000-8000-000000000001', 'legacyOperation', 'legacy-request',
          'legacy-admin', 'operator', '1', 'operations_admin', 'runtime:read', '{}'
        );
    `)

    for (const [index, migration] of migrations.entries()) {
      await migration.up({ db } as never)
      await db.run(sql`
        INSERT INTO \`payload_migrations\`
          (\`name\`, \`batch\`, \`updated_at\`, \`created_at\`)
        VALUES
          (${migration.name}, ${index + 1}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
      `)
    }
    await migrations[0].up({ db } as never)

    const tables = await db.run(sql`
      SELECT \`name\`
      FROM \`sqlite_master\`
      WHERE \`type\` = 'table' AND \`name\` NOT LIKE 'sqlite_%'
      ORDER BY \`name\`;
    `)
    const recorded = await db.run(sql`
      SELECT \`name\`
      FROM \`payload_migrations\`
      ORDER BY \`batch\`, \`name\`;
    `)
    const legacyReceipts = await db.run(sql`
      SELECT \`operation_id\` FROM \`cloud_operation_receipts\` ORDER BY \`operation_id\`;
    `)

    expect(tables.rows.map((row) => row.name)).toEqual(
      expect.arrayContaining([
        'admins',
        'audit_logs',
        'cloud_operation_receipts',
        'payload_migrations',
        'runtime_instances',
      ]),
    )
    expect(tables.rows).toHaveLength(32)
    expect(recorded.rows.map((row) => row.name)).toEqual(
      migrations.map((migration) => migration.name),
    )
    expect(legacyReceipts.rows).toEqual([
      { operation_id: '00000000-0000-4000-8000-000000000001' },
    ])
  } finally {
    await payload.db.destroy?.()
  }
}, 20_000)
