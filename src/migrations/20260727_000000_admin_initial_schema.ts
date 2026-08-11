import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-sqlite'

export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.run(sql`CREATE TABLE IF NOT EXISTS \`admins_sessions\` (
  	\`_order\` integer NOT NULL,
  	\`_parent_id\` integer NOT NULL,
  	\`id\` text PRIMARY KEY NOT NULL,
  	\`created_at\` text,
  	\`expires_at\` text NOT NULL,
  	FOREIGN KEY (\`_parent_id\`) REFERENCES \`admins\`(\`id\`) ON UPDATE no action ON DELETE cascade
  );
  `)
  await db.run(sql`CREATE INDEX IF NOT EXISTS \`admins_sessions_order_idx\` ON \`admins_sessions\` (\`_order\`);`)
  await db.run(sql`CREATE INDEX IF NOT EXISTS \`admins_sessions_parent_id_idx\` ON \`admins_sessions\` (\`_parent_id\`);`)
  await db.run(sql`CREATE TABLE IF NOT EXISTS \`admins\` (
  	\`id\` integer PRIMARY KEY NOT NULL,
  	\`display_name\` text NOT NULL,
  	\`role\` text DEFAULT 'super_admin' NOT NULL,
  	\`active\` integer DEFAULT true NOT NULL,
  	\`cloud_actor_id\` text,
  	\`totp_secret\` text,
  	\`totp_enabled_at\` text,
  	\`step_up_verified_at\` text,
  	\`updated_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	\`created_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	\`email\` text NOT NULL,
  	\`reset_password_token\` text,
  	\`reset_password_expiration\` text,
  	\`salt\` text,
  	\`hash\` text,
  	\`login_attempts\` numeric DEFAULT 0,
  	\`lock_until\` text
  );
  `)
  await db.run(sql`CREATE UNIQUE INDEX IF NOT EXISTS \`admins_cloud_actor_id_idx\` ON \`admins\` (\`cloud_actor_id\`);`)
  await db.run(sql`CREATE INDEX IF NOT EXISTS \`admins_updated_at_idx\` ON \`admins\` (\`updated_at\`);`)
  await db.run(sql`CREATE INDEX IF NOT EXISTS \`admins_created_at_idx\` ON \`admins\` (\`created_at\`);`)
  await db.run(sql`CREATE UNIQUE INDEX IF NOT EXISTS \`admins_email_idx\` ON \`admins\` (\`email\`);`)
  await db.run(sql`CREATE TABLE IF NOT EXISTS \`media\` (
  	\`id\` integer PRIMARY KEY NOT NULL,
  	\`alt\` text NOT NULL,
  	\`attribution\` text,
  	\`updated_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	\`created_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	\`url\` text,
  	\`thumbnail_u_r_l\` text,
  	\`filename\` text,
  	\`mime_type\` text,
  	\`filesize\` numeric,
  	\`width\` numeric,
  	\`height\` numeric,
  	\`focal_x\` numeric,
  	\`focal_y\` numeric
  );
  `)
  await db.run(sql`CREATE INDEX IF NOT EXISTS \`media_updated_at_idx\` ON \`media\` (\`updated_at\`);`)
  await db.run(sql`CREATE INDEX IF NOT EXISTS \`media_created_at_idx\` ON \`media\` (\`created_at\`);`)
  await db.run(sql`CREATE UNIQUE INDEX IF NOT EXISTS \`media_filename_idx\` ON \`media\` (\`filename\`);`)
  await db.run(sql`CREATE TABLE IF NOT EXISTS \`expert_categories\` (
  	\`id\` integer PRIMARY KEY NOT NULL,
  	\`key\` text NOT NULL,
  	\`name\` text NOT NULL,
  	\`english_name\` text,
  	\`description\` text,
  	\`sort_order\` numeric DEFAULT 0 NOT NULL,
  	\`active\` integer DEFAULT true NOT NULL,
  	\`updated_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	\`created_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
  );
  `)
  await db.run(sql`CREATE UNIQUE INDEX IF NOT EXISTS \`expert_categories_key_idx\` ON \`expert_categories\` (\`key\`);`)
  await db.run(sql`CREATE INDEX IF NOT EXISTS \`expert_categories_updated_at_idx\` ON \`expert_categories\` (\`updated_at\`);`)
  await db.run(sql`CREATE INDEX IF NOT EXISTS \`expert_categories_created_at_idx\` ON \`expert_categories\` (\`created_at\`);`)
  await db.run(sql`CREATE TABLE IF NOT EXISTS \`skill_catalog\` (
  	\`id\` integer PRIMARY KEY NOT NULL,
  	\`key\` text,
  	\`name\` text,
  	\`description\` text,
  	\`runtime_skill_id\` text,
  	\`minimum_runtime_version\` text,
  	\`active\` integer DEFAULT true,
  	\`updated_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	\`created_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	\`_status\` text DEFAULT 'draft'
  );
  `)
  await db.run(sql`CREATE UNIQUE INDEX IF NOT EXISTS \`skill_catalog_key_idx\` ON \`skill_catalog\` (\`key\`);`)
  await db.run(sql`CREATE INDEX IF NOT EXISTS \`skill_catalog_updated_at_idx\` ON \`skill_catalog\` (\`updated_at\`);`)
  await db.run(sql`CREATE INDEX IF NOT EXISTS \`skill_catalog_created_at_idx\` ON \`skill_catalog\` (\`created_at\`);`)
  await db.run(sql`CREATE INDEX IF NOT EXISTS \`skill_catalog__status_idx\` ON \`skill_catalog\` (\`_status\`);`)
  await db.run(sql`CREATE TABLE IF NOT EXISTS \`_skill_catalog_v\` (
  	\`id\` integer PRIMARY KEY NOT NULL,
  	\`parent_id\` integer,
  	\`version_key\` text,
  	\`version_name\` text,
  	\`version_description\` text,
  	\`version_runtime_skill_id\` text,
  	\`version_minimum_runtime_version\` text,
  	\`version_active\` integer DEFAULT true,
  	\`version_updated_at\` text,
  	\`version_created_at\` text,
  	\`version__status\` text DEFAULT 'draft',
  	\`created_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	\`updated_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	\`latest\` integer,
  	FOREIGN KEY (\`parent_id\`) REFERENCES \`skill_catalog\`(\`id\`) ON UPDATE no action ON DELETE set null
  );
  `)
  await db.run(sql`CREATE INDEX IF NOT EXISTS \`_skill_catalog_v_parent_idx\` ON \`_skill_catalog_v\` (\`parent_id\`);`)
  await db.run(sql`CREATE INDEX IF NOT EXISTS \`_skill_catalog_v_version_version_key_idx\` ON \`_skill_catalog_v\` (\`version_key\`);`)
  await db.run(sql`CREATE INDEX IF NOT EXISTS \`_skill_catalog_v_version_version_updated_at_idx\` ON \`_skill_catalog_v\` (\`version_updated_at\`);`)
  await db.run(sql`CREATE INDEX IF NOT EXISTS \`_skill_catalog_v_version_version_created_at_idx\` ON \`_skill_catalog_v\` (\`version_created_at\`);`)
  await db.run(sql`CREATE INDEX IF NOT EXISTS \`_skill_catalog_v_version_version__status_idx\` ON \`_skill_catalog_v\` (\`version__status\`);`)
  await db.run(sql`CREATE INDEX IF NOT EXISTS \`_skill_catalog_v_created_at_idx\` ON \`_skill_catalog_v\` (\`created_at\`);`)
  await db.run(sql`CREATE INDEX IF NOT EXISTS \`_skill_catalog_v_updated_at_idx\` ON \`_skill_catalog_v\` (\`updated_at\`);`)
  await db.run(sql`CREATE INDEX IF NOT EXISTS \`_skill_catalog_v_latest_idx\` ON \`_skill_catalog_v\` (\`latest\`);`)
  await db.run(sql`CREATE TABLE IF NOT EXISTS \`agent_templates_tags\` (
  	\`_order\` integer NOT NULL,
  	\`_parent_id\` integer NOT NULL,
  	\`id\` text PRIMARY KEY NOT NULL,
  	\`value\` text,
  	FOREIGN KEY (\`_parent_id\`) REFERENCES \`agent_templates\`(\`id\`) ON UPDATE no action ON DELETE cascade
  );
  `)
  await db.run(sql`CREATE INDEX IF NOT EXISTS \`agent_templates_tags_order_idx\` ON \`agent_templates_tags\` (\`_order\`);`)
  await db.run(sql`CREATE INDEX IF NOT EXISTS \`agent_templates_tags_parent_id_idx\` ON \`agent_templates_tags\` (\`_parent_id\`);`)
  await db.run(sql`CREATE TABLE IF NOT EXISTS \`agent_templates\` (
  	\`id\` integer PRIMARY KEY NOT NULL,
  	\`template_key\` text,
  	\`name\` text,
  	\`english_name\` text,
  	\`avatar_id\` integer,
  	\`category_id\` integer,
  	\`introduction\` text,
  	\`role_prompt\` text,
  	\`release_version\` numeric DEFAULT 0,
  	\`release_notes\` text,
  	\`minimum_studio_version\` text,
  	\`minimum_runtime_version\` text,
  	\`published_fingerprint\` text,
  	\`updated_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	\`created_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	\`_status\` text DEFAULT 'draft',
  	FOREIGN KEY (\`avatar_id\`) REFERENCES \`media\`(\`id\`) ON UPDATE no action ON DELETE set null,
  	FOREIGN KEY (\`category_id\`) REFERENCES \`expert_categories\`(\`id\`) ON UPDATE no action ON DELETE set null
  );
  `)
  await db.run(sql`CREATE UNIQUE INDEX IF NOT EXISTS \`agent_templates_template_key_idx\` ON \`agent_templates\` (\`template_key\`);`)
  await db.run(sql`CREATE INDEX IF NOT EXISTS \`agent_templates_avatar_idx\` ON \`agent_templates\` (\`avatar_id\`);`)
  await db.run(sql`CREATE INDEX IF NOT EXISTS \`agent_templates_category_idx\` ON \`agent_templates\` (\`category_id\`);`)
  await db.run(sql`CREATE INDEX IF NOT EXISTS \`agent_templates_updated_at_idx\` ON \`agent_templates\` (\`updated_at\`);`)
  await db.run(sql`CREATE INDEX IF NOT EXISTS \`agent_templates_created_at_idx\` ON \`agent_templates\` (\`created_at\`);`)
  await db.run(sql`CREATE INDEX IF NOT EXISTS \`agent_templates__status_idx\` ON \`agent_templates\` (\`_status\`);`)
  await db.run(sql`CREATE TABLE IF NOT EXISTS \`agent_templates_rels\` (
  	\`id\` integer PRIMARY KEY NOT NULL,
  	\`order\` integer,
  	\`parent_id\` integer NOT NULL,
  	\`path\` text NOT NULL,
  	\`skill_catalog_id\` integer,
  	FOREIGN KEY (\`parent_id\`) REFERENCES \`agent_templates\`(\`id\`) ON UPDATE no action ON DELETE cascade,
  	FOREIGN KEY (\`skill_catalog_id\`) REFERENCES \`skill_catalog\`(\`id\`) ON UPDATE no action ON DELETE cascade
  );
  `)
  await db.run(sql`CREATE INDEX IF NOT EXISTS \`agent_templates_rels_order_idx\` ON \`agent_templates_rels\` (\`order\`);`)
  await db.run(sql`CREATE INDEX IF NOT EXISTS \`agent_templates_rels_parent_idx\` ON \`agent_templates_rels\` (\`parent_id\`);`)
  await db.run(sql`CREATE INDEX IF NOT EXISTS \`agent_templates_rels_path_idx\` ON \`agent_templates_rels\` (\`path\`);`)
  await db.run(sql`CREATE INDEX IF NOT EXISTS \`agent_templates_rels_skill_catalog_id_idx\` ON \`agent_templates_rels\` (\`skill_catalog_id\`);`)
  await db.run(sql`CREATE TABLE IF NOT EXISTS \`_agent_templates_v_version_tags\` (
  	\`_order\` integer NOT NULL,
  	\`_parent_id\` integer NOT NULL,
  	\`id\` integer PRIMARY KEY NOT NULL,
  	\`value\` text,
  	\`_uuid\` text,
  	FOREIGN KEY (\`_parent_id\`) REFERENCES \`_agent_templates_v\`(\`id\`) ON UPDATE no action ON DELETE cascade
  );
  `)
  await db.run(sql`CREATE INDEX IF NOT EXISTS \`_agent_templates_v_version_tags_order_idx\` ON \`_agent_templates_v_version_tags\` (\`_order\`);`)
  await db.run(sql`CREATE INDEX IF NOT EXISTS \`_agent_templates_v_version_tags_parent_id_idx\` ON \`_agent_templates_v_version_tags\` (\`_parent_id\`);`)
  await db.run(sql`CREATE TABLE IF NOT EXISTS \`_agent_templates_v\` (
  	\`id\` integer PRIMARY KEY NOT NULL,
  	\`parent_id\` integer,
  	\`version_template_key\` text,
  	\`version_name\` text,
  	\`version_english_name\` text,
  	\`version_avatar_id\` integer,
  	\`version_category_id\` integer,
  	\`version_introduction\` text,
  	\`version_role_prompt\` text,
  	\`version_release_version\` numeric DEFAULT 0,
  	\`version_release_notes\` text,
  	\`version_minimum_studio_version\` text,
  	\`version_minimum_runtime_version\` text,
  	\`version_published_fingerprint\` text,
  	\`version_updated_at\` text,
  	\`version_created_at\` text,
  	\`version__status\` text DEFAULT 'draft',
  	\`created_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	\`updated_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	\`latest\` integer,
  	FOREIGN KEY (\`parent_id\`) REFERENCES \`agent_templates\`(\`id\`) ON UPDATE no action ON DELETE set null,
  	FOREIGN KEY (\`version_avatar_id\`) REFERENCES \`media\`(\`id\`) ON UPDATE no action ON DELETE set null,
  	FOREIGN KEY (\`version_category_id\`) REFERENCES \`expert_categories\`(\`id\`) ON UPDATE no action ON DELETE set null
  );
  `)
  await db.run(sql`CREATE INDEX IF NOT EXISTS \`_agent_templates_v_parent_idx\` ON \`_agent_templates_v\` (\`parent_id\`);`)
  await db.run(sql`CREATE INDEX IF NOT EXISTS \`_agent_templates_v_version_version_template_key_idx\` ON \`_agent_templates_v\` (\`version_template_key\`);`)
  await db.run(sql`CREATE INDEX IF NOT EXISTS \`_agent_templates_v_version_version_avatar_idx\` ON \`_agent_templates_v\` (\`version_avatar_id\`);`)
  await db.run(sql`CREATE INDEX IF NOT EXISTS \`_agent_templates_v_version_version_category_idx\` ON \`_agent_templates_v\` (\`version_category_id\`);`)
  await db.run(sql`CREATE INDEX IF NOT EXISTS \`_agent_templates_v_version_version_updated_at_idx\` ON \`_agent_templates_v\` (\`version_updated_at\`);`)
  await db.run(sql`CREATE INDEX IF NOT EXISTS \`_agent_templates_v_version_version_created_at_idx\` ON \`_agent_templates_v\` (\`version_created_at\`);`)
  await db.run(sql`CREATE INDEX IF NOT EXISTS \`_agent_templates_v_version_version__status_idx\` ON \`_agent_templates_v\` (\`version__status\`);`)
  await db.run(sql`CREATE INDEX IF NOT EXISTS \`_agent_templates_v_created_at_idx\` ON \`_agent_templates_v\` (\`created_at\`);`)
  await db.run(sql`CREATE INDEX IF NOT EXISTS \`_agent_templates_v_updated_at_idx\` ON \`_agent_templates_v\` (\`updated_at\`);`)
  await db.run(sql`CREATE INDEX IF NOT EXISTS \`_agent_templates_v_latest_idx\` ON \`_agent_templates_v\` (\`latest\`);`)
  await db.run(sql`CREATE TABLE IF NOT EXISTS \`_agent_templates_v_rels\` (
  	\`id\` integer PRIMARY KEY NOT NULL,
  	\`order\` integer,
  	\`parent_id\` integer NOT NULL,
  	\`path\` text NOT NULL,
  	\`skill_catalog_id\` integer,
  	FOREIGN KEY (\`parent_id\`) REFERENCES \`_agent_templates_v\`(\`id\`) ON UPDATE no action ON DELETE cascade,
  	FOREIGN KEY (\`skill_catalog_id\`) REFERENCES \`skill_catalog\`(\`id\`) ON UPDATE no action ON DELETE cascade
  );
  `)
  await db.run(sql`CREATE INDEX IF NOT EXISTS \`_agent_templates_v_rels_order_idx\` ON \`_agent_templates_v_rels\` (\`order\`);`)
  await db.run(sql`CREATE INDEX IF NOT EXISTS \`_agent_templates_v_rels_parent_idx\` ON \`_agent_templates_v_rels\` (\`parent_id\`);`)
  await db.run(sql`CREATE INDEX IF NOT EXISTS \`_agent_templates_v_rels_path_idx\` ON \`_agent_templates_v_rels\` (\`path\`);`)
  await db.run(sql`CREATE INDEX IF NOT EXISTS \`_agent_templates_v_rels_skill_catalog_id_idx\` ON \`_agent_templates_v_rels\` (\`skill_catalog_id\`);`)
  await db.run(sql`CREATE TABLE IF NOT EXISTS \`plugin_catalog_compatibility_platforms\` (
  	\`order\` integer NOT NULL,
  	\`parent_id\` integer NOT NULL,
  	\`value\` text,
  	\`id\` integer PRIMARY KEY NOT NULL,
  	FOREIGN KEY (\`parent_id\`) REFERENCES \`plugin_catalog\`(\`id\`) ON UPDATE no action ON DELETE cascade
  );
  `)
  await db.run(sql`CREATE INDEX IF NOT EXISTS \`plugin_catalog_compatibility_platforms_order_idx\` ON \`plugin_catalog_compatibility_platforms\` (\`order\`);`)
  await db.run(sql`CREATE INDEX IF NOT EXISTS \`plugin_catalog_compatibility_platforms_parent_idx\` ON \`plugin_catalog_compatibility_platforms\` (\`parent_id\`);`)
  await db.run(sql`CREATE TABLE IF NOT EXISTS \`plugin_catalog\` (
  	\`id\` integer PRIMARY KEY NOT NULL,
  	\`name\` text,
  	\`slug\` text,
  	\`version\` text,
  	\`summary\` text,
  	\`install_kind\` text,
  	\`artifact_u_r_l\` text,
  	\`checksum\` text,
  	\`compatibility_minimum_runtime_version\` text,
  	\`compatibility_maximum_runtime_version\` text,
  	\`risk_level\` text DEFAULT 'low',
  	\`enabled\` integer DEFAULT true,
  	\`updated_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	\`created_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	\`_status\` text DEFAULT 'draft'
  );
  `)
  await db.run(sql`CREATE INDEX IF NOT EXISTS \`plugin_catalog_slug_idx\` ON \`plugin_catalog\` (\`slug\`);`)
  await db.run(sql`CREATE INDEX IF NOT EXISTS \`plugin_catalog_updated_at_idx\` ON \`plugin_catalog\` (\`updated_at\`);`)
  await db.run(sql`CREATE INDEX IF NOT EXISTS \`plugin_catalog_created_at_idx\` ON \`plugin_catalog\` (\`created_at\`);`)
  await db.run(sql`CREATE INDEX IF NOT EXISTS \`plugin_catalog__status_idx\` ON \`plugin_catalog\` (\`_status\`);`)
  await db.run(sql`CREATE UNIQUE INDEX IF NOT EXISTS \`slug_version_idx\` ON \`plugin_catalog\` (\`slug\`,\`version\`);`)
  await db.run(sql`CREATE TABLE IF NOT EXISTS \`_plugin_catalog_v_version_compatibility_platforms\` (
  	\`order\` integer NOT NULL,
  	\`parent_id\` integer NOT NULL,
  	\`value\` text,
  	\`id\` integer PRIMARY KEY NOT NULL,
  	FOREIGN KEY (\`parent_id\`) REFERENCES \`_plugin_catalog_v\`(\`id\`) ON UPDATE no action ON DELETE cascade
  );
  `)
  await db.run(sql`CREATE INDEX IF NOT EXISTS \`_plugin_catalog_v_version_compatibility_platforms_order_idx\` ON \`_plugin_catalog_v_version_compatibility_platforms\` (\`order\`);`)
  await db.run(sql`CREATE INDEX IF NOT EXISTS \`_plugin_catalog_v_version_compatibility_platforms_parent_idx\` ON \`_plugin_catalog_v_version_compatibility_platforms\` (\`parent_id\`);`)
  await db.run(sql`CREATE TABLE IF NOT EXISTS \`_plugin_catalog_v\` (
  	\`id\` integer PRIMARY KEY NOT NULL,
  	\`parent_id\` integer,
  	\`version_name\` text,
  	\`version_slug\` text,
  	\`version_version\` text,
  	\`version_summary\` text,
  	\`version_install_kind\` text,
  	\`version_artifact_u_r_l\` text,
  	\`version_checksum\` text,
  	\`version_compatibility_minimum_runtime_version\` text,
  	\`version_compatibility_maximum_runtime_version\` text,
  	\`version_risk_level\` text DEFAULT 'low',
  	\`version_enabled\` integer DEFAULT true,
  	\`version_updated_at\` text,
  	\`version_created_at\` text,
  	\`version__status\` text DEFAULT 'draft',
  	\`created_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	\`updated_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	\`latest\` integer,
  	FOREIGN KEY (\`parent_id\`) REFERENCES \`plugin_catalog\`(\`id\`) ON UPDATE no action ON DELETE set null
  );
  `)
  await db.run(sql`CREATE INDEX IF NOT EXISTS \`_plugin_catalog_v_parent_idx\` ON \`_plugin_catalog_v\` (\`parent_id\`);`)
  await db.run(sql`CREATE INDEX IF NOT EXISTS \`_plugin_catalog_v_version_version_slug_idx\` ON \`_plugin_catalog_v\` (\`version_slug\`);`)
  await db.run(sql`CREATE INDEX IF NOT EXISTS \`_plugin_catalog_v_version_version_updated_at_idx\` ON \`_plugin_catalog_v\` (\`version_updated_at\`);`)
  await db.run(sql`CREATE INDEX IF NOT EXISTS \`_plugin_catalog_v_version_version_created_at_idx\` ON \`_plugin_catalog_v\` (\`version_created_at\`);`)
  await db.run(sql`CREATE INDEX IF NOT EXISTS \`_plugin_catalog_v_version_version__status_idx\` ON \`_plugin_catalog_v\` (\`version__status\`);`)
  await db.run(sql`CREATE INDEX IF NOT EXISTS \`_plugin_catalog_v_created_at_idx\` ON \`_plugin_catalog_v\` (\`created_at\`);`)
  await db.run(sql`CREATE INDEX IF NOT EXISTS \`_plugin_catalog_v_updated_at_idx\` ON \`_plugin_catalog_v\` (\`updated_at\`);`)
  await db.run(sql`CREATE INDEX IF NOT EXISTS \`_plugin_catalog_v_latest_idx\` ON \`_plugin_catalog_v\` (\`latest\`);`)
  await db.run(sql`CREATE INDEX IF NOT EXISTS \`version_slug_version_version_idx\` ON \`_plugin_catalog_v\` (\`version_slug\`,\`version_version\`);`)
  await db.run(sql`CREATE TABLE IF NOT EXISTS \`pet_assets\` (
  	\`id\` integer PRIMARY KEY NOT NULL,
  	\`name\` text,
  	\`slug\` text,
  	\`version\` text,
  	\`manifest\` text,
  	\`sprite_media_id\` integer,
  	\`preview_media_id\` integer,
  	\`compatibility_minimum_studio_version\` text,
  	\`compatibility_minimum_runtime_version\` text,
  	\`enabled\` integer DEFAULT true,
  	\`updated_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	\`created_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	\`_status\` text DEFAULT 'draft',
  	FOREIGN KEY (\`sprite_media_id\`) REFERENCES \`media\`(\`id\`) ON UPDATE no action ON DELETE set null,
  	FOREIGN KEY (\`preview_media_id\`) REFERENCES \`media\`(\`id\`) ON UPDATE no action ON DELETE set null
  );
  `)
  await db.run(sql`CREATE INDEX IF NOT EXISTS \`pet_assets_slug_idx\` ON \`pet_assets\` (\`slug\`);`)
  await db.run(sql`CREATE INDEX IF NOT EXISTS \`pet_assets_sprite_media_idx\` ON \`pet_assets\` (\`sprite_media_id\`);`)
  await db.run(sql`CREATE INDEX IF NOT EXISTS \`pet_assets_preview_media_idx\` ON \`pet_assets\` (\`preview_media_id\`);`)
  await db.run(sql`CREATE INDEX IF NOT EXISTS \`pet_assets_updated_at_idx\` ON \`pet_assets\` (\`updated_at\`);`)
  await db.run(sql`CREATE INDEX IF NOT EXISTS \`pet_assets_created_at_idx\` ON \`pet_assets\` (\`created_at\`);`)
  await db.run(sql`CREATE INDEX IF NOT EXISTS \`pet_assets__status_idx\` ON \`pet_assets\` (\`_status\`);`)
  await db.run(sql`CREATE UNIQUE INDEX IF NOT EXISTS \`slug_version_1_idx\` ON \`pet_assets\` (\`slug\`,\`version\`);`)
  await db.run(sql`CREATE TABLE IF NOT EXISTS \`_pet_assets_v\` (
  	\`id\` integer PRIMARY KEY NOT NULL,
  	\`parent_id\` integer,
  	\`version_name\` text,
  	\`version_slug\` text,
  	\`version_version\` text,
  	\`version_manifest\` text,
  	\`version_sprite_media_id\` integer,
  	\`version_preview_media_id\` integer,
  	\`version_compatibility_minimum_studio_version\` text,
  	\`version_compatibility_minimum_runtime_version\` text,
  	\`version_enabled\` integer DEFAULT true,
  	\`version_updated_at\` text,
  	\`version_created_at\` text,
  	\`version__status\` text DEFAULT 'draft',
  	\`created_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	\`updated_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	\`latest\` integer,
  	FOREIGN KEY (\`parent_id\`) REFERENCES \`pet_assets\`(\`id\`) ON UPDATE no action ON DELETE set null,
  	FOREIGN KEY (\`version_sprite_media_id\`) REFERENCES \`media\`(\`id\`) ON UPDATE no action ON DELETE set null,
  	FOREIGN KEY (\`version_preview_media_id\`) REFERENCES \`media\`(\`id\`) ON UPDATE no action ON DELETE set null
  );
  `)
  await db.run(sql`CREATE INDEX IF NOT EXISTS \`_pet_assets_v_parent_idx\` ON \`_pet_assets_v\` (\`parent_id\`);`)
  await db.run(sql`CREATE INDEX IF NOT EXISTS \`_pet_assets_v_version_version_slug_idx\` ON \`_pet_assets_v\` (\`version_slug\`);`)
  await db.run(sql`CREATE INDEX IF NOT EXISTS \`_pet_assets_v_version_version_sprite_media_idx\` ON \`_pet_assets_v\` (\`version_sprite_media_id\`);`)
  await db.run(sql`CREATE INDEX IF NOT EXISTS \`_pet_assets_v_version_version_preview_media_idx\` ON \`_pet_assets_v\` (\`version_preview_media_id\`);`)
  await db.run(sql`CREATE INDEX IF NOT EXISTS \`_pet_assets_v_version_version_updated_at_idx\` ON \`_pet_assets_v\` (\`version_updated_at\`);`)
  await db.run(sql`CREATE INDEX IF NOT EXISTS \`_pet_assets_v_version_version_created_at_idx\` ON \`_pet_assets_v\` (\`version_created_at\`);`)
  await db.run(sql`CREATE INDEX IF NOT EXISTS \`_pet_assets_v_version_version__status_idx\` ON \`_pet_assets_v\` (\`version__status\`);`)
  await db.run(sql`CREATE INDEX IF NOT EXISTS \`_pet_assets_v_created_at_idx\` ON \`_pet_assets_v\` (\`created_at\`);`)
  await db.run(sql`CREATE INDEX IF NOT EXISTS \`_pet_assets_v_updated_at_idx\` ON \`_pet_assets_v\` (\`updated_at\`);`)
  await db.run(sql`CREATE INDEX IF NOT EXISTS \`_pet_assets_v_latest_idx\` ON \`_pet_assets_v\` (\`latest\`);`)
  await db.run(sql`CREATE INDEX IF NOT EXISTS \`version_slug_version_version_1_idx\` ON \`_pet_assets_v\` (\`version_slug\`,\`version_version\`);`)
  await db.run(sql`CREATE TABLE IF NOT EXISTS \`integration_settings\` (
  	\`id\` integer PRIMARY KEY NOT NULL,
  	\`service\` text NOT NULL,
  	\`enabled\` integer DEFAULT false NOT NULL,
  	\`health_status\` text NOT NULL,
  	\`last_checked_at\` text NOT NULL,
  	\`last_error_code\` text,
  	\`updated_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	\`created_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
  );
  `)
  await db.run(sql`CREATE UNIQUE INDEX IF NOT EXISTS \`integration_settings_service_idx\` ON \`integration_settings\` (\`service\`);`)
  await db.run(sql`CREATE INDEX IF NOT EXISTS \`integration_settings_updated_at_idx\` ON \`integration_settings\` (\`updated_at\`);`)
  await db.run(sql`CREATE INDEX IF NOT EXISTS \`integration_settings_created_at_idx\` ON \`integration_settings\` (\`created_at\`);`)
  await db.run(sql`CREATE TABLE IF NOT EXISTS \`audit_logs\` (
  	\`id\` integer PRIMARY KEY NOT NULL,
  	\`actor_id\` text NOT NULL,
  	\`actor_email\` text,
  	\`actor_role\` text NOT NULL,
  	\`capability\` text NOT NULL,
  	\`action\` text NOT NULL,
  	\`resource_type\` text NOT NULL,
  	\`resource_id\` text,
  	\`resource_name\` text,
  	\`request_id\` text NOT NULL,
  	\`operation_id\` text,
  	\`upstream_request_id\` text,
  	\`outcome\` text NOT NULL,
  	\`error_code\` text,
  	\`ip\` text,
  	\`user_agent\` text,
  	\`before\` text,
  	\`after\` text,
  	\`occurred_at\` text NOT NULL
  );
  `)
  await db.run(sql`CREATE INDEX IF NOT EXISTS \`audit_logs_actor_id_idx\` ON \`audit_logs\` (\`actor_id\`);`)
  await db.run(sql`CREATE INDEX IF NOT EXISTS \`audit_logs_actor_email_idx\` ON \`audit_logs\` (\`actor_email\`);`)
  await db.run(sql`CREATE INDEX IF NOT EXISTS \`audit_logs_action_idx\` ON \`audit_logs\` (\`action\`);`)
  await db.run(sql`CREATE INDEX IF NOT EXISTS \`audit_logs_resource_type_idx\` ON \`audit_logs\` (\`resource_type\`);`)
  await db.run(sql`CREATE INDEX IF NOT EXISTS \`audit_logs_resource_id_idx\` ON \`audit_logs\` (\`resource_id\`);`)
  await db.run(sql`CREATE INDEX IF NOT EXISTS \`audit_logs_request_id_idx\` ON \`audit_logs\` (\`request_id\`);`)
  await db.run(sql`CREATE UNIQUE INDEX IF NOT EXISTS \`audit_logs_operation_id_idx\` ON \`audit_logs\` (\`operation_id\`);`)
  await db.run(sql`CREATE INDEX IF NOT EXISTS \`audit_logs_upstream_request_id_idx\` ON \`audit_logs\` (\`upstream_request_id\`);`)
  await db.run(sql`CREATE INDEX IF NOT EXISTS \`audit_logs_occurred_at_idx\` ON \`audit_logs\` (\`occurred_at\`);`)
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
  );
  `)
  await db.run(sql`CREATE UNIQUE INDEX IF NOT EXISTS \`cloud_operation_receipts_operation_id_idx\` ON \`cloud_operation_receipts\` (\`operation_id\`);`)
  await db.run(sql`CREATE INDEX IF NOT EXISTS \`cloud_operation_receipts_operation_key_idx\` ON \`cloud_operation_receipts\` (\`operation_key\`);`)
  await db.run(sql`CREATE INDEX IF NOT EXISTS \`cloud_operation_receipts_request_id_idx\` ON \`cloud_operation_receipts\` (\`request_id\`);`)
  await db.run(sql`CREATE INDEX IF NOT EXISTS \`cloud_operation_receipts_actor_admin_id_idx\` ON \`cloud_operation_receipts\` (\`actor_admin_id\`);`)
  await db.run(sql`CREATE INDEX IF NOT EXISTS \`cloud_operation_receipts_status_idx\` ON \`cloud_operation_receipts\` (\`status\`);`)
  await db.run(sql`CREATE INDEX IF NOT EXISTS \`cloud_operation_receipts_next_attempt_at_idx\` ON \`cloud_operation_receipts\` (\`next_attempt_at\`);`)
  await db.run(sql`CREATE INDEX IF NOT EXISTS \`cloud_operation_receipts_lease_owner_idx\` ON \`cloud_operation_receipts\` (\`lease_owner\`);`)
  await db.run(sql`CREATE INDEX IF NOT EXISTS \`cloud_operation_receipts_lease_expires_at_idx\` ON \`cloud_operation_receipts\` (\`lease_expires_at\`);`)
  await db.run(sql`CREATE INDEX IF NOT EXISTS \`cloud_operation_receipts_upstream_request_id_idx\` ON \`cloud_operation_receipts\` (\`upstream_request_id\`);`)
  await db.run(sql`CREATE INDEX IF NOT EXISTS \`cloud_operation_receipts_updated_at_idx\` ON \`cloud_operation_receipts\` (\`updated_at\`);`)
  await db.run(sql`CREATE INDEX IF NOT EXISTS \`cloud_operation_receipts_created_at_idx\` ON \`cloud_operation_receipts\` (\`created_at\`);`)
  await db.run(sql`CREATE TABLE IF NOT EXISTS \`official_rollback_requests\` (
  	\`id\` integer PRIMARY KEY NOT NULL,
  	\`approval_id\` text,
  	\`release_id\` text NOT NULL,
  	\`target_version_id\` text NOT NULL,
  	\`target_release_revision_id\` text NOT NULL,
  	\`expected_revision\` numeric NOT NULL,
  	\`reason_code\` text NOT NULL,
  	\`ticket_reference\` text,
  	\`status\` text DEFAULT 'requested' NOT NULL,
  	\`requested_by_id\` integer NOT NULL,
  	\`requested_by_actor_id\` text NOT NULL,
  	\`decided_by_id\` integer,
  	\`decided_by_actor_id\` text,
  	\`decided_at\` text,
  	\`decision_note\` text,
  	\`executed_at\` text,
  	\`operation_id\` text,
  	\`updated_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	\`created_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	FOREIGN KEY (\`requested_by_id\`) REFERENCES \`admins\`(\`id\`) ON UPDATE no action ON DELETE set null,
  	FOREIGN KEY (\`decided_by_id\`) REFERENCES \`admins\`(\`id\`) ON UPDATE no action ON DELETE set null
  );
  `)
  await db.run(sql`CREATE UNIQUE INDEX IF NOT EXISTS \`official_rollback_requests_approval_id_idx\` ON \`official_rollback_requests\` (\`approval_id\`);`)
  await db.run(sql`CREATE INDEX IF NOT EXISTS \`official_rollback_requests_release_id_idx\` ON \`official_rollback_requests\` (\`release_id\`);`)
  await db.run(sql`CREATE INDEX IF NOT EXISTS \`official_rollback_requests_status_idx\` ON \`official_rollback_requests\` (\`status\`);`)
  await db.run(sql`CREATE INDEX IF NOT EXISTS \`official_rollback_requests_requested_by_idx\` ON \`official_rollback_requests\` (\`requested_by_id\`);`)
  await db.run(sql`CREATE INDEX IF NOT EXISTS \`official_rollback_requests_decided_by_idx\` ON \`official_rollback_requests\` (\`decided_by_id\`);`)
  await db.run(sql`CREATE INDEX IF NOT EXISTS \`official_rollback_requests_updated_at_idx\` ON \`official_rollback_requests\` (\`updated_at\`);`)
  await db.run(sql`CREATE INDEX IF NOT EXISTS \`official_rollback_requests_created_at_idx\` ON \`official_rollback_requests\` (\`created_at\`);`)
  await db.run(sql`CREATE TABLE IF NOT EXISTS \`runtime_instances\` (
  	\`id\` integer PRIMARY KEY NOT NULL,
  	\`name\` text NOT NULL,
  	\`instance_type\` text NOT NULL,
  	\`tenant_id\` text,
  	\`status\` text DEFAULT 'pending' NOT NULL,
  	\`device_id_hash\` text NOT NULL,
  	\`device_secret_hash\` text,
  	\`enrollment_code_hash\` text,
  	\`enrollment_expires_at\` text,
  	\`version\` text,
  	\`os\` text,
  	\`arch\` text,
  	\`capabilities\` text DEFAULT '[]',
  	\`last_heartbeat_at\` text,
  	\`health_summary\` text,
  	\`channels\` text DEFAULT '[]',
  	\`resources\` text,
  	\`updated_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	\`created_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
  );
  `)
  await db.run(sql`CREATE INDEX IF NOT EXISTS \`runtime_instances_tenant_id_idx\` ON \`runtime_instances\` (\`tenant_id\`);`)
  await db.run(sql`CREATE UNIQUE INDEX IF NOT EXISTS \`runtime_instances_device_id_hash_idx\` ON \`runtime_instances\` (\`device_id_hash\`);`)
  await db.run(sql`CREATE UNIQUE INDEX IF NOT EXISTS \`runtime_instances_enrollment_code_hash_idx\` ON \`runtime_instances\` (\`enrollment_code_hash\`);`)
  await db.run(sql`CREATE INDEX IF NOT EXISTS \`runtime_instances_last_heartbeat_at_idx\` ON \`runtime_instances\` (\`last_heartbeat_at\`);`)
  await db.run(sql`CREATE INDEX IF NOT EXISTS \`runtime_instances_updated_at_idx\` ON \`runtime_instances\` (\`updated_at\`);`)
  await db.run(sql`CREATE INDEX IF NOT EXISTS \`runtime_instances_created_at_idx\` ON \`runtime_instances\` (\`created_at\`);`)
  await db.run(sql`CREATE TABLE IF NOT EXISTS \`runtime_releases\` (
  	\`id\` integer PRIMARY KEY NOT NULL,
  	\`product\` text NOT NULL,
  	\`version\` text NOT NULL,
  	\`channel\` text NOT NULL,
  	\`minimum_version\` text,
  	\`artifact_u_r_l\` text NOT NULL,
  	\`checksum\` text NOT NULL,
  	\`published_at\` text,
  	\`status\` text DEFAULT 'draft' NOT NULL,
  	\`updated_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	\`created_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
  );
  `)
  await db.run(sql`CREATE INDEX IF NOT EXISTS \`runtime_releases_updated_at_idx\` ON \`runtime_releases\` (\`updated_at\`);`)
  await db.run(sql`CREATE INDEX IF NOT EXISTS \`runtime_releases_created_at_idx\` ON \`runtime_releases\` (\`created_at\`);`)
  await db.run(sql`CREATE TABLE IF NOT EXISTS \`runtime_commands\` (
  	\`id\` integer PRIMARY KEY NOT NULL,
  	\`instance_id\` integer NOT NULL,
  	\`type\` text NOT NULL,
  	\`required_capability\` text NOT NULL,
  	\`idempotency_key\` text NOT NULL,
  	\`command_key\` text NOT NULL,
  	\`state\` text DEFAULT 'queued' NOT NULL,
  	\`expires_at\` text,
  	\`claimed_at\` text,
  	\`started_at\` text,
  	\`completed_at\` text,
  	\`result_code\` text,
  	\`result_summary\` text,
  	\`created_by_id\` integer,
  	\`updated_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	\`created_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	FOREIGN KEY (\`instance_id\`) REFERENCES \`runtime_instances\`(\`id\`) ON UPDATE no action ON DELETE set null,
  	FOREIGN KEY (\`created_by_id\`) REFERENCES \`admins\`(\`id\`) ON UPDATE no action ON DELETE set null
  );
  `)
  await db.run(sql`CREATE INDEX IF NOT EXISTS \`runtime_commands_instance_idx\` ON \`runtime_commands\` (\`instance_id\`);`)
  await db.run(sql`CREATE UNIQUE INDEX IF NOT EXISTS \`runtime_commands_command_key_idx\` ON \`runtime_commands\` (\`command_key\`);`)
  await db.run(sql`CREATE INDEX IF NOT EXISTS \`runtime_commands_expires_at_idx\` ON \`runtime_commands\` (\`expires_at\`);`)
  await db.run(sql`CREATE INDEX IF NOT EXISTS \`runtime_commands_created_by_idx\` ON \`runtime_commands\` (\`created_by_id\`);`)
  await db.run(sql`CREATE INDEX IF NOT EXISTS \`runtime_commands_updated_at_idx\` ON \`runtime_commands\` (\`updated_at\`);`)
  await db.run(sql`CREATE INDEX IF NOT EXISTS \`runtime_commands_created_at_idx\` ON \`runtime_commands\` (\`created_at\`);`)
  await db.run(sql`CREATE TABLE IF NOT EXISTS \`runtime_events\` (
  	\`id\` integer PRIMARY KEY NOT NULL,
  	\`instance_id\` integer NOT NULL,
  	\`kind\` text NOT NULL,
  	\`severity\` text NOT NULL,
  	\`code\` text,
  	\`summary\` text NOT NULL,
  	\`occurred_at\` text NOT NULL,
  	\`expires_at\` text,
  	\`updated_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	\`created_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	FOREIGN KEY (\`instance_id\`) REFERENCES \`runtime_instances\`(\`id\`) ON UPDATE no action ON DELETE set null
  );
  `)
  await db.run(sql`CREATE INDEX IF NOT EXISTS \`runtime_events_instance_idx\` ON \`runtime_events\` (\`instance_id\`);`)
  await db.run(sql`CREATE INDEX IF NOT EXISTS \`runtime_events_kind_idx\` ON \`runtime_events\` (\`kind\`);`)
  await db.run(sql`CREATE INDEX IF NOT EXISTS \`runtime_events_code_idx\` ON \`runtime_events\` (\`code\`);`)
  await db.run(sql`CREATE INDEX IF NOT EXISTS \`runtime_events_occurred_at_idx\` ON \`runtime_events\` (\`occurred_at\`);`)
  await db.run(sql`CREATE INDEX IF NOT EXISTS \`runtime_events_expires_at_idx\` ON \`runtime_events\` (\`expires_at\`);`)
  await db.run(sql`CREATE INDEX IF NOT EXISTS \`runtime_events_updated_at_idx\` ON \`runtime_events\` (\`updated_at\`);`)
  await db.run(sql`CREATE INDEX IF NOT EXISTS \`runtime_events_created_at_idx\` ON \`runtime_events\` (\`created_at\`);`)
  await db.run(sql`CREATE TABLE IF NOT EXISTS \`payload_kv\` (
  	\`id\` integer PRIMARY KEY NOT NULL,
  	\`key\` text NOT NULL,
  	\`data\` text NOT NULL
  );
  `)
  await db.run(sql`CREATE UNIQUE INDEX IF NOT EXISTS \`payload_kv_key_idx\` ON \`payload_kv\` (\`key\`);`)
  await db.run(sql`CREATE TABLE IF NOT EXISTS \`payload_locked_documents\` (
  	\`id\` integer PRIMARY KEY NOT NULL,
  	\`global_slug\` text,
  	\`updated_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	\`created_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
  );
  `)
  await db.run(sql`CREATE INDEX IF NOT EXISTS \`payload_locked_documents_global_slug_idx\` ON \`payload_locked_documents\` (\`global_slug\`);`)
  await db.run(sql`CREATE INDEX IF NOT EXISTS \`payload_locked_documents_updated_at_idx\` ON \`payload_locked_documents\` (\`updated_at\`);`)
  await db.run(sql`CREATE INDEX IF NOT EXISTS \`payload_locked_documents_created_at_idx\` ON \`payload_locked_documents\` (\`created_at\`);`)
  await db.run(sql`CREATE TABLE IF NOT EXISTS \`payload_locked_documents_rels\` (
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
  await db.run(sql`CREATE INDEX IF NOT EXISTS \`payload_locked_documents_rels_order_idx\` ON \`payload_locked_documents_rels\` (\`order\`);`)
  await db.run(sql`CREATE INDEX IF NOT EXISTS \`payload_locked_documents_rels_parent_idx\` ON \`payload_locked_documents_rels\` (\`parent_id\`);`)
  await db.run(sql`CREATE INDEX IF NOT EXISTS \`payload_locked_documents_rels_path_idx\` ON \`payload_locked_documents_rels\` (\`path\`);`)
  await db.run(sql`CREATE INDEX IF NOT EXISTS \`payload_locked_documents_rels_admins_id_idx\` ON \`payload_locked_documents_rels\` (\`admins_id\`);`)
  await db.run(sql`CREATE INDEX IF NOT EXISTS \`payload_locked_documents_rels_media_id_idx\` ON \`payload_locked_documents_rels\` (\`media_id\`);`)
  await db.run(sql`CREATE INDEX IF NOT EXISTS \`payload_locked_documents_rels_expert_categories_id_idx\` ON \`payload_locked_documents_rels\` (\`expert_categories_id\`);`)
  await db.run(sql`CREATE INDEX IF NOT EXISTS \`payload_locked_documents_rels_skill_catalog_id_idx\` ON \`payload_locked_documents_rels\` (\`skill_catalog_id\`);`)
  await db.run(sql`CREATE INDEX IF NOT EXISTS \`payload_locked_documents_rels_agent_templates_id_idx\` ON \`payload_locked_documents_rels\` (\`agent_templates_id\`);`)
  await db.run(sql`CREATE INDEX IF NOT EXISTS \`payload_locked_documents_rels_plugin_catalog_id_idx\` ON \`payload_locked_documents_rels\` (\`plugin_catalog_id\`);`)
  await db.run(sql`CREATE INDEX IF NOT EXISTS \`payload_locked_documents_rels_pet_assets_id_idx\` ON \`payload_locked_documents_rels\` (\`pet_assets_id\`);`)
  await db.run(sql`CREATE INDEX IF NOT EXISTS \`payload_locked_documents_rels_integration_settings_id_idx\` ON \`payload_locked_documents_rels\` (\`integration_settings_id\`);`)
  await db.run(sql`CREATE INDEX IF NOT EXISTS \`payload_locked_documents_rels_audit_logs_id_idx\` ON \`payload_locked_documents_rels\` (\`audit_logs_id\`);`)
  await db.run(sql`CREATE INDEX IF NOT EXISTS \`payload_locked_documents_rels_cloud_operation_receipts_i_idx\` ON \`payload_locked_documents_rels\` (\`cloud_operation_receipts_id\`);`)
  await db.run(sql`CREATE INDEX IF NOT EXISTS \`payload_locked_documents_rels_official_rollback_requests_idx\` ON \`payload_locked_documents_rels\` (\`official_rollback_requests_id\`);`)
  await db.run(sql`CREATE INDEX IF NOT EXISTS \`payload_locked_documents_rels_runtime_instances_id_idx\` ON \`payload_locked_documents_rels\` (\`runtime_instances_id\`);`)
  await db.run(sql`CREATE INDEX IF NOT EXISTS \`payload_locked_documents_rels_runtime_releases_id_idx\` ON \`payload_locked_documents_rels\` (\`runtime_releases_id\`);`)
  await db.run(sql`CREATE INDEX IF NOT EXISTS \`payload_locked_documents_rels_runtime_commands_id_idx\` ON \`payload_locked_documents_rels\` (\`runtime_commands_id\`);`)
  await db.run(sql`CREATE INDEX IF NOT EXISTS \`payload_locked_documents_rels_runtime_events_id_idx\` ON \`payload_locked_documents_rels\` (\`runtime_events_id\`);`)
  await db.run(sql`CREATE TABLE IF NOT EXISTS \`payload_preferences\` (
  	\`id\` integer PRIMARY KEY NOT NULL,
  	\`key\` text,
  	\`value\` text,
  	\`updated_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	\`created_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
  );
  `)
  await db.run(sql`CREATE INDEX IF NOT EXISTS \`payload_preferences_key_idx\` ON \`payload_preferences\` (\`key\`);`)
  await db.run(sql`CREATE INDEX IF NOT EXISTS \`payload_preferences_updated_at_idx\` ON \`payload_preferences\` (\`updated_at\`);`)
  await db.run(sql`CREATE INDEX IF NOT EXISTS \`payload_preferences_created_at_idx\` ON \`payload_preferences\` (\`created_at\`);`)
  await db.run(sql`CREATE TABLE IF NOT EXISTS \`payload_preferences_rels\` (
  	\`id\` integer PRIMARY KEY NOT NULL,
  	\`order\` integer,
  	\`parent_id\` integer NOT NULL,
  	\`path\` text NOT NULL,
  	\`admins_id\` integer,
  	FOREIGN KEY (\`parent_id\`) REFERENCES \`payload_preferences\`(\`id\`) ON UPDATE no action ON DELETE cascade,
  	FOREIGN KEY (\`admins_id\`) REFERENCES \`admins\`(\`id\`) ON UPDATE no action ON DELETE cascade
  );
  `)
  await db.run(sql`CREATE INDEX IF NOT EXISTS \`payload_preferences_rels_order_idx\` ON \`payload_preferences_rels\` (\`order\`);`)
  await db.run(sql`CREATE INDEX IF NOT EXISTS \`payload_preferences_rels_parent_idx\` ON \`payload_preferences_rels\` (\`parent_id\`);`)
  await db.run(sql`CREATE INDEX IF NOT EXISTS \`payload_preferences_rels_path_idx\` ON \`payload_preferences_rels\` (\`path\`);`)
  await db.run(sql`CREATE INDEX IF NOT EXISTS \`payload_preferences_rels_admins_id_idx\` ON \`payload_preferences_rels\` (\`admins_id\`);`)
  await db.run(sql`CREATE TABLE IF NOT EXISTS \`payload_migrations\` (
  	\`id\` integer PRIMARY KEY NOT NULL,
  	\`name\` text,
  	\`batch\` numeric,
  	\`updated_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	\`created_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
  );
  `)
  await db.run(sql`CREATE INDEX IF NOT EXISTS \`payload_migrations_updated_at_idx\` ON \`payload_migrations\` (\`updated_at\`);`)
  await db.run(sql`CREATE INDEX IF NOT EXISTS \`payload_migrations_created_at_idx\` ON \`payload_migrations\` (\`created_at\`);`)
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
  await db.run(sql`DROP TABLE \`admins_sessions\`;`)
  await db.run(sql`DROP TABLE \`admins\`;`)
  await db.run(sql`DROP TABLE \`media\`;`)
  await db.run(sql`DROP TABLE \`expert_categories\`;`)
  await db.run(sql`DROP TABLE \`skill_catalog\`;`)
  await db.run(sql`DROP TABLE \`_skill_catalog_v\`;`)
  await db.run(sql`DROP TABLE \`agent_templates_tags\`;`)
  await db.run(sql`DROP TABLE \`agent_templates\`;`)
  await db.run(sql`DROP TABLE \`agent_templates_rels\`;`)
  await db.run(sql`DROP TABLE \`_agent_templates_v_version_tags\`;`)
  await db.run(sql`DROP TABLE \`_agent_templates_v\`;`)
  await db.run(sql`DROP TABLE \`_agent_templates_v_rels\`;`)
  await db.run(sql`DROP TABLE \`plugin_catalog_compatibility_platforms\`;`)
  await db.run(sql`DROP TABLE \`plugin_catalog\`;`)
  await db.run(sql`DROP TABLE \`_plugin_catalog_v_version_compatibility_platforms\`;`)
  await db.run(sql`DROP TABLE \`_plugin_catalog_v\`;`)
  await db.run(sql`DROP TABLE \`pet_assets\`;`)
  await db.run(sql`DROP TABLE \`_pet_assets_v\`;`)
  await db.run(sql`DROP TABLE \`integration_settings\`;`)
  await db.run(sql`DROP TABLE \`audit_logs\`;`)
  await db.run(sql`DROP TABLE \`cloud_operation_receipts\`;`)
  await db.run(sql`DROP TABLE \`official_rollback_requests\`;`)
  await db.run(sql`DROP TABLE \`runtime_instances\`;`)
  await db.run(sql`DROP TABLE \`runtime_releases\`;`)
  await db.run(sql`DROP TABLE \`runtime_commands\`;`)
  await db.run(sql`DROP TABLE \`runtime_events\`;`)
  await db.run(sql`DROP TABLE \`payload_kv\`;`)
  await db.run(sql`DROP TABLE \`payload_locked_documents\`;`)
  await db.run(sql`DROP TABLE \`payload_locked_documents_rels\`;`)
  await db.run(sql`DROP TABLE \`payload_preferences\`;`)
  await db.run(sql`DROP TABLE \`payload_preferences_rels\`;`)
  await db.run(sql`DROP TABLE \`payload_migrations\`;`)
}
