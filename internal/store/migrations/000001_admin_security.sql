CREATE TABLE reason_codes (
    code TEXT PRIMARY KEY,
    category TEXT NOT NULL,
    label TEXT NOT NULL,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT reason_codes_code_check CHECK (code ~ '^[a-z][a-z0-9_]{2,63}$'),
    CONSTRAINT reason_codes_category_check CHECK (category IN ('administrator', 'session', 'device', 'account', 'security')),
    CONSTRAINT reason_codes_label_check CHECK (char_length(btrim(label)) BETWEEN 1 AND 80),
    CONSTRAINT reason_codes_timestamps_check CHECK (updated_at >= created_at)
);

CREATE TABLE admin_users (
    id UUID PRIMARY KEY,
    display_name TEXT NOT NULL,
    role TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'invited',
    security_version BIGINT NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT admin_users_display_name_check CHECK (char_length(btrim(display_name)) BETWEEN 1 AND 100),
    CONSTRAINT admin_users_role_check CHECK (role IN ('super_admin', 'developer', 'operator', 'support', 'finance', 'auditor')),
    CONSTRAINT admin_users_status_check CHECK (status IN ('invited', 'active', 'suspended')),
    CONSTRAINT admin_users_security_version_check CHECK (security_version > 0),
    CONSTRAINT admin_users_timestamps_check CHECK (updated_at >= created_at)
);

CREATE INDEX admin_users_role_status_idx ON admin_users (role, status, id);

CREATE TABLE admin_identities (
    admin_user_id UUID PRIMARY KEY REFERENCES admin_users(id) ON DELETE CASCADE,
    encryption_key_id TEXT NOT NULL,
    nonce BYTEA NOT NULL,
    ciphertext BYTEA NOT NULL,
    lookup_key_id TEXT NOT NULL,
    lookup_hmac BYTEA NOT NULL,
    CONSTRAINT admin_identities_encryption_key_check CHECK (char_length(btrim(encryption_key_id)) BETWEEN 1 AND 100),
    CONSTRAINT admin_identities_nonce_length_check CHECK (octet_length(nonce) = 12),
    CONSTRAINT admin_identities_ciphertext_length_check CHECK (octet_length(ciphertext) > 16),
    CONSTRAINT admin_identities_lookup_key_check CHECK (char_length(btrim(lookup_key_id)) BETWEEN 1 AND 100),
    CONSTRAINT admin_identities_lookup_hmac_length_check CHECK (octet_length(lookup_hmac) = 32),
    CONSTRAINT admin_identities_lookup_key UNIQUE (lookup_key_id, lookup_hmac)
);

CREATE TABLE admin_password_credentials (
    admin_user_id UUID PRIMARY KEY REFERENCES admin_users(id) ON DELETE CASCADE,
    password_hash TEXT NOT NULL,
    params_version INTEGER NOT NULL,
    changed_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT admin_password_credentials_hash_check CHECK (char_length(password_hash) BETWEEN 32 AND 1024),
    CONSTRAINT admin_password_credentials_params_version_check CHECK (params_version > 0)
);

CREATE TABLE admin_totp_credentials (
    admin_user_id UUID PRIMARY KEY REFERENCES admin_users(id) ON DELETE CASCADE,
    encryption_key_id TEXT NOT NULL,
    nonce BYTEA NOT NULL,
    ciphertext BYTEA NOT NULL,
    last_accepted_step BIGINT NOT NULL DEFAULT -1,
    bound_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT admin_totp_credentials_encryption_key_check CHECK (char_length(btrim(encryption_key_id)) BETWEEN 1 AND 100),
    CONSTRAINT admin_totp_credentials_nonce_length_check CHECK (octet_length(nonce) = 12),
    CONSTRAINT admin_totp_credentials_ciphertext_length_check CHECK (octet_length(ciphertext) > 16),
    CONSTRAINT admin_totp_credentials_last_step_check CHECK (last_accepted_step >= -1),
    CONSTRAINT admin_totp_credentials_timestamps_check CHECK (updated_at >= bound_at)
);

CREATE TABLE admin_recovery_codes (
    admin_user_id UUID NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
    code_hmac BYTEA NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ,
    PRIMARY KEY (admin_user_id, code_hmac),
    CONSTRAINT admin_recovery_codes_hmac_length_check CHECK (octet_length(code_hmac) = 32),
    CONSTRAINT admin_recovery_codes_consumed_check CHECK (consumed_at IS NULL OR consumed_at >= created_at)
);

CREATE TABLE admin_sessions (
    id UUID PRIMARY KEY,
    admin_user_id UUID NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
    token_hmac BYTEA NOT NULL UNIQUE,
    csrf_hmac BYTEA NOT NULL,
    security_version BIGINT NOT NULL,
    role TEXT NOT NULL,
    mfa_authenticated_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    last_seen_at TIMESTAMPTZ NOT NULL,
    idle_expires_at TIMESTAMPTZ NOT NULL,
    absolute_expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    CONSTRAINT admin_sessions_token_hmac_length_check CHECK (octet_length(token_hmac) = 32),
    CONSTRAINT admin_sessions_csrf_hmac_length_check CHECK (octet_length(csrf_hmac) = 32),
    CONSTRAINT admin_sessions_security_version_check CHECK (security_version > 0),
    CONSTRAINT admin_sessions_role_check CHECK (role IN ('super_admin', 'developer', 'operator', 'support', 'finance', 'auditor')),
    CONSTRAINT admin_sessions_last_seen_check CHECK (last_seen_at >= created_at),
    CONSTRAINT admin_sessions_idle_expiry_check CHECK (idle_expires_at > created_at),
    CONSTRAINT admin_sessions_absolute_expiry_check CHECK (absolute_expires_at > idle_expires_at),
    CONSTRAINT admin_sessions_mfa_time_check CHECK (mfa_authenticated_at >= created_at AND mfa_authenticated_at <= absolute_expires_at),
    CONSTRAINT admin_sessions_revoked_check CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);

CREATE INDEX admin_sessions_live_user_idx
    ON admin_sessions (admin_user_id, absolute_expires_at)
    WHERE revoked_at IS NULL;

CREATE TABLE admin_invitations (
    id UUID PRIMARY KEY,
    admin_user_id UUID NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
    token_hmac BYTEA NOT NULL UNIQUE,
    created_by_admin_id UUID REFERENCES admin_users(id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ,
    CONSTRAINT admin_invitations_token_hmac_length_check CHECK (octet_length(token_hmac) = 32),
    CONSTRAINT admin_invitations_expiry_check CHECK (expires_at > created_at),
    CONSTRAINT admin_invitations_consumed_check CHECK (consumed_at IS NULL OR consumed_at >= created_at)
);

CREATE INDEX admin_invitations_user_created_idx ON admin_invitations (admin_user_id, created_at DESC);

CREATE TABLE admin_audit_events (
    id UUID PRIMARY KEY,
    actor_admin_id UUID REFERENCES admin_users(id) ON DELETE SET NULL,
    actor_role TEXT,
    event_type TEXT NOT NULL,
    object_type TEXT NOT NULL,
    object_id UUID,
    outcome TEXT NOT NULL,
    reason_code TEXT REFERENCES reason_codes(code) ON DELETE RESTRICT,
    ticket_reference TEXT,
    note TEXT,
    approval_id UUID,
    operation_id UUID,
    error_code TEXT,
    before_state JSONB,
    after_state JSONB,
    request_id TEXT NOT NULL,
    source_ip_hmac BYTEA,
    user_agent TEXT,
    previous_hash BYTEA NOT NULL,
    event_hash BYTEA NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT admin_audit_events_actor_role_check CHECK (actor_role IS NULL OR actor_role IN ('super_admin', 'developer', 'operator', 'support', 'finance', 'auditor')),
    CONSTRAINT admin_audit_events_event_type_check CHECK (char_length(btrim(event_type)) BETWEEN 1 AND 100),
    CONSTRAINT admin_audit_events_object_type_check CHECK (char_length(btrim(object_type)) BETWEEN 1 AND 100),
    CONSTRAINT admin_audit_events_outcome_check CHECK (outcome IN ('success', 'failure', 'denied')),
    CONSTRAINT admin_audit_events_ticket_reference_check CHECK (ticket_reference IS NULL OR char_length(ticket_reference) BETWEEN 1 AND 128),
    CONSTRAINT admin_audit_events_note_check CHECK (note IS NULL OR char_length(note) BETWEEN 1 AND 500),
    CONSTRAINT admin_audit_events_error_code_check CHECK (error_code IS NULL OR error_code ~ '^[A-Z][A-Z0-9_]{2,99}$'),
    CONSTRAINT admin_audit_events_before_state_check CHECK (before_state IS NULL OR jsonb_typeof(before_state) = 'object'),
    CONSTRAINT admin_audit_events_after_state_check CHECK (after_state IS NULL OR jsonb_typeof(after_state) = 'object'),
    CONSTRAINT admin_audit_events_request_id_check CHECK (char_length(request_id) BETWEEN 1 AND 128),
    CONSTRAINT admin_audit_events_source_ip_hmac_length_check CHECK (source_ip_hmac IS NULL OR octet_length(source_ip_hmac) = 32),
    CONSTRAINT admin_audit_events_user_agent_check CHECK (user_agent IS NULL OR char_length(user_agent) BETWEEN 1 AND 512),
    CONSTRAINT admin_audit_events_previous_hash_length_check CHECK (octet_length(previous_hash) = 32),
    CONSTRAINT admin_audit_events_event_hash_length_check CHECK (octet_length(event_hash) = 32)
);

CREATE INDEX admin_audit_events_created_idx ON admin_audit_events (created_at DESC, id);
CREATE INDEX admin_audit_events_actor_created_idx ON admin_audit_events (actor_admin_id, created_at DESC, id);
CREATE INDEX admin_audit_events_object_created_idx ON admin_audit_events (object_type, object_id, created_at DESC, id);

CREATE TABLE admin_audit_checkpoints (
    checkpoint_date DATE PRIMARY KEY,
    last_event_id UUID NOT NULL REFERENCES admin_audit_events(id) ON DELETE RESTRICT,
    event_hash BYTEA NOT NULL,
    signing_key_id TEXT NOT NULL,
    signature BYTEA NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT admin_audit_checkpoints_event_hash_length_check CHECK (octet_length(event_hash) = 32),
    CONSTRAINT admin_audit_checkpoints_signing_key_check CHECK (char_length(btrim(signing_key_id)) BETWEEN 1 AND 100),
    CONSTRAINT admin_audit_checkpoints_signature_length_check CHECK (octet_length(signature) = 64)
);

CREATE FUNCTION reject_admin_audit_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'administrator audit records are append-only' USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER admin_audit_events_append_only
    BEFORE UPDATE OR DELETE ON admin_audit_events
    FOR EACH ROW EXECUTE FUNCTION reject_admin_audit_mutation();

CREATE TRIGGER admin_audit_checkpoints_append_only
    BEFORE UPDATE OR DELETE ON admin_audit_checkpoints
    FOR EACH ROW EXECUTE FUNCTION reject_admin_audit_mutation();

REVOKE UPDATE, DELETE, TRUNCATE ON admin_audit_events FROM PUBLIC;
REVOKE UPDATE, DELETE, TRUNCATE ON admin_audit_checkpoints FROM PUBLIC;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aera_admin_runtime') THEN
        EXECUTE format('GRANT USAGE ON SCHEMA %I TO aera_admin_runtime', current_schema());
        EXECUTE format('GRANT SELECT, INSERT ON %I.admin_audit_events TO aera_admin_runtime', current_schema());
        EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON %I.admin_audit_events FROM aera_admin_runtime', current_schema());
        EXECUTE format('GRANT SELECT, INSERT ON %I.admin_audit_checkpoints TO aera_admin_runtime', current_schema());
        EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON %I.admin_audit_checkpoints FROM aera_admin_runtime', current_schema());
    END IF;
END;
$$;

INSERT INTO reason_codes (code, category, label, created_at, updated_at) VALUES
    ('staff_change', 'administrator', '人员或职责变更', now(), now()),
    ('access_review', 'administrator', '访问权限复核', now(), now()),
    ('mfa_reset', 'administrator', '管理员 MFA 重置', now(), now()),
    ('account_suspension', 'administrator', '管理员账号暂停', now(), now()),
    ('session_cleanup', 'session', '会话安全清理', now(), now()),
    ('suspected_compromise', 'security', '疑似凭证泄露', now(), now()),
    ('security_incident', 'security', '安全事件处置', now(), now()),
    ('lost_device', 'device', '设备遗失', now(), now()),
    ('device_replacement', 'device', '设备更换', now(), now()),
    ('customer_request', 'account', '客户请求', now(), now()),
    ('policy_violation', 'account', '违反使用政策', now(), now()),
    ('account_recovery', 'account', '账号恢复', now(), now());
