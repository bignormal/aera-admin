import { type MigrateDownArgs, type MigrateUpArgs, sql } from '@payloadcms/db-sqlite'

function hasColumn(
  result: Awaited<ReturnType<MigrateUpArgs['db']['run']>>,
  column: string,
): boolean {
  return result.rows.some((row) => row.name === column)
}

export async function up({ db }: MigrateUpArgs): Promise<void> {
  const auditColumns = await db.run(sql`PRAGMA table_info(\`audit_logs\`);`)
  if (auditColumns.rows.length > 0 && !hasColumn(auditColumns, 'operation_id')) {
    await db.run(sql`ALTER TABLE \`audit_logs\` ADD COLUMN \`operation_id\` text;`)
  }
  if (auditColumns.rows.length > 0) {
    await db.run(
      sql`CREATE UNIQUE INDEX IF NOT EXISTS \`audit_logs_operation_id_idx\` ON \`audit_logs\` (\`operation_id\`);`,
    )
  }

  await db.run(sql`CREATE TABLE IF NOT EXISTS \`cloud_operation_receipts\` (
    \`id\` integer PRIMARY KEY NOT NULL,
    \`operation_id\` text NOT NULL,
    \`operation_key\` text NOT NULL,
    \`request_id\` text NOT NULL,
    \`actor_admin_id\` text NOT NULL,
    \`actor_role\` text NOT NULL,
    \`local_actor_id\` text NOT NULL,
    \`local_actor_role\` text NOT NULL,
    \`capability\` text NOT NULL,
    \`request\` text NOT NULL,
    \`rollback_request_id\` text,
    \`status\` text DEFAULT 'pending' NOT NULL,
    \`administrative_revision\` numeric,
    \`cloud_status\` text,
    \`cloud_updated_at\` text,
    \`error_code\` text,
    \`last_error_code\` text,
    \`definitive_failure\` integer DEFAULT false NOT NULL,
    \`attempt_count\` numeric DEFAULT 0 NOT NULL,
    \`last_attempt_at\` text,
    \`next_attempt_at\` text,
    \`lease_owner\` text,
    \`lease_expires_at\` text,
    \`audit_completed_at\` text,
    \`rollback_completed_at\` text,
    \`upstream_request_id\` text,
    \`updated_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
    \`created_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
  );`)
  await db.run(
    sql`CREATE UNIQUE INDEX IF NOT EXISTS \`cloud_operation_receipts_operation_id_idx\` ON \`cloud_operation_receipts\` (\`operation_id\`);`,
  )
  await db.run(
    sql`CREATE INDEX IF NOT EXISTS \`cloud_operation_receipts_operation_key_idx\` ON \`cloud_operation_receipts\` (\`operation_key\`);`,
  )
  await db.run(
    sql`CREATE INDEX IF NOT EXISTS \`cloud_operation_receipts_request_id_idx\` ON \`cloud_operation_receipts\` (\`request_id\`);`,
  )
  await db.run(
    sql`CREATE INDEX IF NOT EXISTS \`cloud_operation_receipts_actor_admin_id_idx\` ON \`cloud_operation_receipts\` (\`actor_admin_id\`);`,
  )
  await db.run(
    sql`CREATE INDEX IF NOT EXISTS \`cloud_operation_receipts_status_idx\` ON \`cloud_operation_receipts\` (\`status\`);`,
  )
  await db.run(
    sql`CREATE INDEX IF NOT EXISTS \`cloud_operation_receipts_next_attempt_at_idx\` ON \`cloud_operation_receipts\` (\`next_attempt_at\`);`,
  )
  await db.run(
    sql`CREATE INDEX IF NOT EXISTS \`cloud_operation_receipts_lease_owner_idx\` ON \`cloud_operation_receipts\` (\`lease_owner\`);`,
  )
  await db.run(
    sql`CREATE INDEX IF NOT EXISTS \`cloud_operation_receipts_lease_expires_at_idx\` ON \`cloud_operation_receipts\` (\`lease_expires_at\`);`,
  )
  await db.run(
    sql`CREATE INDEX IF NOT EXISTS \`cloud_operation_receipts_upstream_request_id_idx\` ON \`cloud_operation_receipts\` (\`upstream_request_id\`);`,
  )
  await db.run(
    sql`CREATE INDEX IF NOT EXISTS \`cloud_operation_receipts_updated_at_idx\` ON \`cloud_operation_receipts\` (\`updated_at\`);`,
  )
  await db.run(
    sql`CREATE INDEX IF NOT EXISTS \`cloud_operation_receipts_created_at_idx\` ON \`cloud_operation_receipts\` (\`created_at\`);`,
  )

  const lockedRelationColumns = await db.run(
    sql`PRAGMA table_info(\`payload_locked_documents_rels\`);`,
  )
  if (
    lockedRelationColumns.rows.length > 0 &&
    !hasColumn(lockedRelationColumns, 'cloud_operation_receipts_id')
  ) {
    await db.run(
      sql`ALTER TABLE \`payload_locked_documents_rels\` ADD COLUMN \`cloud_operation_receipts_id\` integer;`,
    )
  }
  if (lockedRelationColumns.rows.length > 0) {
    await db.run(
      sql`CREATE INDEX IF NOT EXISTS \`payload_locked_documents_rels_cloud_operation_receipts_i_idx\` ON \`payload_locked_documents_rels\` (\`cloud_operation_receipts_id\`);`,
    )
  }
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
  await db.run(sql`DROP TABLE IF EXISTS \`cloud_operation_receipts\`;`)
  await db.run(sql`DROP INDEX IF EXISTS \`audit_logs_operation_id_idx\`;`)
}
