import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-sqlite'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.run(
    sql`ALTER TABLE \`skill_catalog\` ADD \`distribution_class\` text DEFAULT 'runtime_public';`,
  )
  await db.run(
    sql`ALTER TABLE \`_skill_catalog_v\` ADD \`version_distribution_class\` text DEFAULT 'runtime_public';`,
  )
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.run(sql`ALTER TABLE \`skill_catalog\` DROP COLUMN \`distribution_class\`;`)
  await db.run(sql`ALTER TABLE \`_skill_catalog_v\` DROP COLUMN \`version_distribution_class\`;`)
}
