-- Editable RBAC: data-driven custom roles.
-- Roles and their permission grants move out of hardcoded Go (internal/rbac)
-- into these tables so operators can create, rename, and delete roles. The
-- permission CATALOG stays code-defined; only role -> permission edges live here.

CREATE TABLE admin_roles (
    slug TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    is_system BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT admin_roles_slug_check CHECK (slug ~ '^[a-z][a-z0-9_]{1,49}$'),
    CONSTRAINT admin_roles_name_check CHECK (char_length(btrim(name)) BETWEEN 1 AND 100),
    CONSTRAINT admin_roles_description_check CHECK (char_length(description) <= 500),
    CONSTRAINT admin_roles_timestamps_check CHECK (updated_at >= created_at)
);

CREATE TABLE admin_role_permissions (
    role_slug TEXT NOT NULL REFERENCES admin_roles(slug) ON UPDATE CASCADE ON DELETE CASCADE,
    permission TEXT NOT NULL,
    PRIMARY KEY (role_slug, permission),
    CONSTRAINT admin_role_permissions_permission_check CHECK (permission ~ '^[a-z][a-z0-9_.]{2,99}$')
);

-- Seed the six former fixed roles as protected system roles.
INSERT INTO admin_roles (slug, name, description, is_system, created_at, updated_at) VALUES
    ('super_admin', '超级管理员', '管理员安全、内容审核、回滚批准与系统策略管理', true, now(), now()),
    ('developer', '开发人员', '官方 Agent 草稿开发、技术诊断与服务健康', true, now(), now()),
    ('operator', '运营人员', '日常运营处置、官方发布与回滚发起方', true, now(), now()),
    ('support', '客服人员', '用户、设备与会话支持', true, now(), now()),
    ('finance', '财务人员', '一期不授予安全控制台权限', true, now(), now()),
    ('auditor', '审计人员', '只读管理员、官方资产与审计、健康与系统设置', true, now(), now());

-- Seed the current fixed permission matrix (finance intentionally has none).
INSERT INTO admin_role_permissions (role_slug, permission) VALUES
    ('super_admin', 'administrator.manage'),
    ('super_admin', 'administrator.read'),
    ('super_admin', 'cloud_user.read'),
    ('super_admin', 'cloud_user.read_technical'),
    ('super_admin', 'cloud_identity.lookup_exact'),
    ('super_admin', 'cloud_device.read'),
    ('super_admin', 'cloud_session.revoke'),
    ('super_admin', 'cloud_device.revoke'),
    ('super_admin', 'account_lifecycle.approve'),
    ('super_admin', 'audit.read_full'),
    ('super_admin', 'service_health.read'),
    ('super_admin', 'system_settings.read'),
    ('super_admin', 'system_settings.manage'),
    ('super_admin', 'official_agent.read'),
    ('super_admin', 'official_agent.review'),
    ('super_admin', 'official_agent.rollback.approve'),
    ('super_admin', 'official_agent.audit.read'),
    ('developer', 'cloud_user.read_technical'),
    ('developer', 'cloud_device.read'),
    ('developer', 'service_health.read'),
    ('developer', 'official_agent.read'),
    ('developer', 'official_agent.draft.manage'),
    ('operator', 'cloud_user.read'),
    ('operator', 'cloud_identity.lookup_exact'),
    ('operator', 'cloud_device.read'),
    ('operator', 'cloud_session.revoke'),
    ('operator', 'cloud_device.revoke'),
    ('operator', 'account_lifecycle.initiate'),
    ('operator', 'audit.read_own'),
    ('operator', 'service_health.read'),
    ('operator', 'official_agent.read'),
    ('operator', 'official_agent.release.manage'),
    ('operator', 'official_agent.rollback.request'),
    ('support', 'cloud_user.read'),
    ('support', 'cloud_identity.lookup_exact'),
    ('support', 'cloud_device.read'),
    ('support', 'cloud_session.revoke'),
    ('support', 'cloud_device.revoke'),
    ('support', 'audit.read_own'),
    ('auditor', 'administrator.read'),
    ('auditor', 'audit.read_full'),
    ('auditor', 'service_health.read'),
    ('auditor', 'system_settings.read'),
    ('auditor', 'official_agent.read'),
    ('auditor', 'official_agent.audit.read');

-- Roles are data-driven now: drop the hardcoded six-value CHECK constraints.
ALTER TABLE admin_users DROP CONSTRAINT admin_users_role_check;
ALTER TABLE admin_sessions DROP CONSTRAINT admin_sessions_role_check;
ALTER TABLE admin_audit_events DROP CONSTRAINT admin_audit_events_actor_role_check;

-- Bind admin_users.role to the role catalog; a role that is still assigned to
-- an administrator cannot be deleted. Sessions and audit keep a plain role
-- string (transient / historical) so they survive later role deletions.
ALTER TABLE admin_users
    ADD CONSTRAINT admin_users_role_fk FOREIGN KEY (role)
    REFERENCES admin_roles(slug) ON UPDATE CASCADE ON DELETE RESTRICT;
