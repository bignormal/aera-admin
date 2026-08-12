import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-sqlite'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.run(sql`CREATE TABLE \`content_delivery_links\` (
	\`id\` integer PRIMARY KEY NOT NULL,
	\`resource_type\` text NOT NULL,
	\`payload_document_id\` text NOT NULL,
	\`stable_key\` text NOT NULL,
	\`cloud_definition_id\` text,
	\`cloud_draft_id\` text,
	\`cloud_submission_id\` text,
	\`cloud_version_id\` text,
	\`cloud_release_id\` text,
	\`payload_revision\` numeric,
	\`content_digest\` text,
	\`runtime_manifest_sha256\` text,
	\`sync_status\` text DEFAULT 'local_only' NOT NULL,
	\`last_operation_id\` text,
	\`last_request_id\` text,
	\`last_error_code\` text,
	\`last_error_summary\` text,
	\`desktop_verification\` text,
	\`updated_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	\`created_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
  );
  `)
  await db.run(sql`CREATE INDEX \`content_delivery_links_resource_type_idx\` ON \`content_delivery_links\` (\`resource_type\`);`)
  await db.run(sql`CREATE INDEX \`content_delivery_links_payload_document_id_idx\` ON \`content_delivery_links\` (\`payload_document_id\`);`)
  await db.run(sql`CREATE INDEX \`content_delivery_links_stable_key_idx\` ON \`content_delivery_links\` (\`stable_key\`);`)
  await db.run(sql`CREATE INDEX \`content_delivery_links_cloud_definition_id_idx\` ON \`content_delivery_links\` (\`cloud_definition_id\`);`)
  await db.run(sql`CREATE INDEX \`content_delivery_links_cloud_draft_id_idx\` ON \`content_delivery_links\` (\`cloud_draft_id\`);`)
  await db.run(sql`CREATE INDEX \`content_delivery_links_cloud_submission_id_idx\` ON \`content_delivery_links\` (\`cloud_submission_id\`);`)
  await db.run(sql`CREATE INDEX \`content_delivery_links_cloud_version_id_idx\` ON \`content_delivery_links\` (\`cloud_version_id\`);`)
  await db.run(sql`CREATE INDEX \`content_delivery_links_cloud_release_id_idx\` ON \`content_delivery_links\` (\`cloud_release_id\`);`)
  await db.run(sql`CREATE INDEX \`content_delivery_links_sync_status_idx\` ON \`content_delivery_links\` (\`sync_status\`);`)
  await db.run(sql`CREATE INDEX \`content_delivery_links_last_operation_id_idx\` ON \`content_delivery_links\` (\`last_operation_id\`);`)
  await db.run(sql`CREATE INDEX \`content_delivery_links_last_request_id_idx\` ON \`content_delivery_links\` (\`last_request_id\`);`)
  await db.run(sql`CREATE INDEX \`content_delivery_links_updated_at_idx\` ON \`content_delivery_links\` (\`updated_at\`);`)
  await db.run(sql`CREATE INDEX \`content_delivery_links_created_at_idx\` ON \`content_delivery_links\` (\`created_at\`);`)
  await db.run(sql`ALTER TABLE \`payload_locked_documents_rels\` ADD \`content_delivery_links_id\` integer REFERENCES content_delivery_links(id);`)
  await db.run(sql`CREATE INDEX \`payload_locked_documents_rels_content_delivery_links_id_idx\` ON \`payload_locked_documents_rels\` (\`content_delivery_links_id\`);`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.run(sql`DROP TABLE \`content_delivery_links\`;`)
  await db.run(sql`PRAGMA foreign_keys=OFF;`)
  await db.run(sql`CREATE TABLE \`__new_payload_locked_documents_rels\` (
	\`id\` integer PRIMARY KEY NOT NULL,
	\`order\` integer,
	\`parent_id\` integer NOT NULL,
	\`path\` text NOT NULL,
	\`admins_id\` integer,
	\`media_id\` integer,
	\`expert_categories_id\` integer,
	\`skill_catalog_id\` integer,
	\`agent_templates_id\` integer,
	\`plugin_catalog_id\` integer,
	\`pet_assets_id\` integer,
	\`integration_settings_id\` integer,
	\`audit_logs_id\` integer,
	\`cloud_operation_receipts_id\` integer,
	\`official_rollback_requests_id\` integer,
	\`runtime_instances_id\` integer,
	\`runtime_releases_id\` integer,
	\`runtime_commands_id\` integer,
	\`runtime_events_id\` integer,
	FOREIGN KEY (\`parent_id\`) REFERENCES \`payload_locked_documents\`(\`id\`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (\`admins_id\`) REFERENCES \`admins\`(\`id\`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (\`media_id\`) REFERENCES \`media\`(\`id\`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (\`expert_categories_id\`) REFERENCES \`expert_categories\`(\`id\`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (\`skill_catalog_id\`) REFERENCES \`skill_catalog\`(\`id\`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (\`agent_templates_id\`) REFERENCES \`agent_templates\`(\`id\`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (\`plugin_catalog_id\`) REFERENCES \`plugin_catalog\`(\`id\`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (\`pet_assets_id\`) REFERENCES \`pet_assets\`(\`id\`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (\`integration_settings_id\`) REFERENCES \`integration_settings\`(\`id\`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (\`audit_logs_id\`) REFERENCES \`audit_logs\`(\`id\`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (\`cloud_operation_receipts_id\`) REFERENCES \`cloud_operation_receipts\`(\`id\`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (\`official_rollback_requests_id\`) REFERENCES \`official_rollback_requests\`(\`id\`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (\`runtime_instances_id\`) REFERENCES \`runtime_instances\`(\`id\`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (\`runtime_releases_id\`) REFERENCES \`runtime_releases\`(\`id\`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (\`runtime_commands_id\`) REFERENCES \`runtime_commands\`(\`id\`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (\`runtime_events_id\`) REFERENCES \`runtime_events\`(\`id\`) ON UPDATE no action ON DELETE cascade
  );
  `)
  await db.run(sql`INSERT INTO \`__new_payload_locked_documents_rels\`("id", "order", "parent_id", "path", "admins_id", "media_id", "expert_categories_id", "skill_catalog_id", "agent_templates_id", "plugin_catalog_id", "pet_assets_id", "integration_settings_id", "audit_logs_id", "cloud_operation_receipts_id", "official_rollback_requests_id", "runtime_instances_id", "runtime_releases_id", "runtime_commands_id", "runtime_events_id") SELECT "id", "order", "parent_id", "path", "admins_id", "media_id", "expert_categories_id", "skill_catalog_id", "agent_templates_id", "plugin_catalog_id", "pet_assets_id", "integration_settings_id", "audit_logs_id", "cloud_operation_receipts_id", "official_rollback_requests_id", "runtime_instances_id", "runtime_releases_id", "runtime_commands_id", "runtime_events_id" FROM \`payload_locked_documents_rels\`;`)
  await db.run(sql`DROP TABLE \`payload_locked_documents_rels\`;`)
  await db.run(sql`ALTER TABLE \`__new_payload_locked_documents_rels\` RENAME TO \`payload_locked_documents_rels\`;`)
  await db.run(sql`PRAGMA foreign_keys=ON;`)
  await db.run(sql`CREATE INDEX \`payload_locked_documents_rels_order_idx\` ON \`payload_locked_documents_rels\` (\`order\`);`)
  await db.run(sql`CREATE INDEX \`payload_locked_documents_rels_parent_idx\` ON \`payload_locked_documents_rels\` (\`parent_id\`);`)
  await db.run(sql`CREATE INDEX \`payload_locked_documents_rels_path_idx\` ON \`payload_locked_documents_rels\` (\`path\`);`)
  await db.run(sql`CREATE INDEX \`payload_locked_documents_rels_admins_id_idx\` ON \`payload_locked_documents_rels\` (\`admins_id\`);`)
  await db.run(sql`CREATE INDEX \`payload_locked_documents_rels_media_id_idx\` ON \`payload_locked_documents_rels\` (\`media_id\`);`)
  await db.run(sql`CREATE INDEX \`payload_locked_documents_rels_expert_categories_id_idx\` ON \`payload_locked_documents_rels\` (\`expert_categories_id\`);`)
  await db.run(sql`CREATE INDEX \`payload_locked_documents_rels_skill_catalog_id_idx\` ON \`payload_locked_documents_rels\` (\`skill_catalog_id\`);`)
  await db.run(sql`CREATE INDEX \`payload_locked_documents_rels_agent_templates_id_idx\` ON \`payload_locked_documents_rels\` (\`agent_templates_id\`);`)
  await db.run(sql`CREATE INDEX \`payload_locked_documents_rels_plugin_catalog_id_idx\` ON \`payload_locked_documents_rels\` (\`plugin_catalog_id\`);`)
  await db.run(sql`CREATE INDEX \`payload_locked_documents_rels_pet_assets_id_idx\` ON \`payload_locked_documents_rels\` (\`pet_assets_id\`);`)
  await db.run(sql`CREATE INDEX \`payload_locked_documents_rels_integration_settings_id_idx\` ON \`payload_locked_documents_rels\` (\`integration_settings_id\`);`)
  await db.run(sql`CREATE INDEX \`payload_locked_documents_rels_audit_logs_id_idx\` ON \`payload_locked_documents_rels\` (\`audit_logs_id\`);`)
  await db.run(sql`CREATE INDEX \`payload_locked_documents_rels_cloud_operation_receipts_i_idx\` ON \`payload_locked_documents_rels\` (\`cloud_operation_receipts_id\`);`)
  await db.run(sql`CREATE INDEX \`payload_locked_documents_rels_official_rollback_requests_idx\` ON \`payload_locked_documents_rels\` (\`official_rollback_requests_id\`);`)
  await db.run(sql`CREATE INDEX \`payload_locked_documents_rels_runtime_instances_id_idx\` ON \`payload_locked_documents_rels\` (\`runtime_instances_id\`);`)
  await db.run(sql`CREATE INDEX \`payload_locked_documents_rels_runtime_releases_id_idx\` ON \`payload_locked_documents_rels\` (\`runtime_releases_id\`);`)
  await db.run(sql`CREATE INDEX \`payload_locked_documents_rels_runtime_commands_id_idx\` ON \`payload_locked_documents_rels\` (\`runtime_commands_id\`);`)
  await db.run(sql`CREATE INDEX \`payload_locked_documents_rels_runtime_events_id_idx\` ON \`payload_locked_documents_rels\` (\`runtime_events_id\`);`)
}
