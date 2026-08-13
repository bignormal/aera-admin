import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-sqlite'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.run(sql`ALTER TABLE \`plugin_catalog\` ADD \`delivery_status\` text DEFAULT 'registered';`)
  await db.run(sql`ALTER TABLE \`_plugin_catalog_v\` ADD \`version_delivery_status\` text DEFAULT 'registered';`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.run(sql`ALTER TABLE \`plugin_catalog\` DROP COLUMN \`delivery_status\`;`)
  await db.run(sql`ALTER TABLE \`_plugin_catalog_v\` DROP COLUMN \`version_delivery_status\`;`)
}
