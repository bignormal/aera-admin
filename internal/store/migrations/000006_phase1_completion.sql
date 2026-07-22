ALTER TABLE reason_codes
    ADD COLUMN revision BIGINT NOT NULL DEFAULT 1,
    ADD CONSTRAINT reason_codes_revision_check CHECK (revision > 0);

CREATE FUNCTION reject_reason_code_identity_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.code IS DISTINCT FROM OLD.code OR NEW.category IS DISTINCT FROM OLD.category THEN
        RAISE EXCEPTION 'reason code and category are immutable' USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER reason_codes_identity_immutable
    BEFORE UPDATE ON reason_codes
    FOR EACH ROW EXECUTE FUNCTION reject_reason_code_identity_mutation();

INSERT INTO reason_codes (code, category, label, active, created_at, updated_at, revision) VALUES
    ('security_policy_change', 'security', '安全策略调整', TRUE, now(), now(), 1),
    ('reason_catalog_change', 'security', '标准原因目录调整', TRUE, now(), now(), 1);

CREATE TABLE admin_security_settings (
    settings_key TEXT PRIMARY KEY,
    session_idle_minutes INTEGER NOT NULL,
    session_absolute_hours INTEGER NOT NULL,
    audit_retention_days INTEGER NOT NULL,
    revision BIGINT NOT NULL,
    updated_by_admin_id UUID REFERENCES admin_users(id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT admin_security_settings_key_check CHECK (settings_key = 'global'),
    CONSTRAINT admin_security_settings_idle_check CHECK (session_idle_minutes BETWEEN 5 AND 120),
    CONSTRAINT admin_security_settings_absolute_check CHECK (session_absolute_hours BETWEEN 1 AND 24),
    CONSTRAINT admin_security_settings_lifetimes_check CHECK (session_absolute_hours * 60 > session_idle_minutes),
    CONSTRAINT admin_security_settings_retention_check CHECK (audit_retention_days BETWEEN 365 AND 3650),
    CONSTRAINT admin_security_settings_revision_check CHECK (revision > 0),
    CONSTRAINT admin_security_settings_timestamps_check CHECK (updated_at >= created_at)
);

INSERT INTO admin_security_settings (
    settings_key, session_idle_minutes, session_absolute_hours,
    audit_retention_days, revision, created_at, updated_at
) VALUES ('global', 30, 8, 730, 1, now(), now());

CREATE TABLE admin_settings_idempotency (
    operation_id UUID PRIMARY KEY,
    actor_admin_id UUID NOT NULL REFERENCES admin_users(id) ON DELETE RESTRICT,
    action TEXT NOT NULL,
    idempotency_key_hmac BYTEA NOT NULL,
    request_hash BYTEA NOT NULL,
    response_status INTEGER NOT NULL,
    response_body JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT admin_settings_idempotency_actor_key UNIQUE (actor_admin_id, action, idempotency_key_hmac),
    CONSTRAINT admin_settings_idempotency_action_check CHECK (
        action IN ('update_security_policy', 'create_reason_code', 'update_reason_code')
    ),
    CONSTRAINT admin_settings_idempotency_key_length_check CHECK (octet_length(idempotency_key_hmac) = 32),
    CONSTRAINT admin_settings_idempotency_request_length_check CHECK (octet_length(request_hash) = 32),
    CONSTRAINT admin_settings_idempotency_status_check CHECK (response_status BETWEEN 200 AND 299),
    CONSTRAINT admin_settings_idempotency_response_check CHECK (jsonb_typeof(response_body) = 'object'),
    CONSTRAINT admin_settings_idempotency_expiry_check CHECK (expires_at > created_at)
);

CREATE INDEX admin_settings_idempotency_expiry_idx
    ON admin_settings_idempotency (expires_at, operation_id);

CREATE INDEX admin_audit_events_event_created_idx
    ON admin_audit_events (event_type, created_at DESC, id DESC);

CREATE INDEX admin_audit_events_outcome_created_idx
    ON admin_audit_events (outcome, created_at DESC, id DESC);

CREATE INDEX admin_audit_events_reason_created_idx
    ON admin_audit_events (reason_code, created_at DESC, id DESC)
    WHERE reason_code IS NOT NULL;
