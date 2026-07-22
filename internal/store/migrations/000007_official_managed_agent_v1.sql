ALTER TABLE admin_idempotency_records
    ADD COLUMN command_payload BYTEA NOT NULL DEFAULT decode('7b7d', 'hex'),
    ADD COLUMN command_payload_digest BYTEA NOT NULL DEFAULT decode(
        '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
        'hex'
    ),
    ADD CONSTRAINT admin_idempotency_records_payload_length_check CHECK (
        octet_length(command_payload) BETWEEN 2 AND 131072
    ),
    ADD CONSTRAINT admin_idempotency_records_payload_digest_length_check CHECK (
        octet_length(command_payload_digest) = 32
    );

ALTER TABLE admin_outbox
    ADD COLUMN command_payload BYTEA NOT NULL DEFAULT decode('7b7d', 'hex'),
    ADD COLUMN command_payload_digest BYTEA NOT NULL DEFAULT decode(
        '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
        'hex'
    ),
    ADD CONSTRAINT admin_outbox_payload_length_check CHECK (
        octet_length(command_payload) BETWEEN 2 AND 131072
    ),
    ADD CONSTRAINT admin_outbox_payload_digest_length_check CHECK (
        octet_length(command_payload_digest) = 32
    );

ALTER TABLE admin_idempotency_records DROP CONSTRAINT admin_idempotency_action_check;
ALTER TABLE admin_idempotency_records ADD CONSTRAINT admin_idempotency_records_action_check CHECK (
    action IN (
        'revoke_device', 'revoke_session', 'disable_user', 'enable_user',
        'official_definition_reserve', 'official_draft_create', 'official_draft_update',
        'official_draft_submit', 'official_submission_withdraw', 'official_submission_review',
        'official_release_activate', 'official_release_rollout', 'official_release_pause',
        'official_release_resume', 'official_release_rollback'
    )
);

ALTER TABLE admin_outbox DROP CONSTRAINT admin_outbox_action_check;
ALTER TABLE admin_outbox ADD CONSTRAINT admin_outbox_action_check CHECK (
    action IN (
        'revoke_device', 'revoke_session', 'disable_user', 'enable_user',
        'official_definition_reserve', 'official_draft_create', 'official_draft_update',
        'official_draft_submit', 'official_submission_withdraw', 'official_submission_review',
        'official_release_activate', 'official_release_rollout', 'official_release_pause',
        'official_release_resume', 'official_release_rollback'
    )
);

ALTER TABLE reason_codes DROP CONSTRAINT reason_codes_category_check;
ALTER TABLE reason_codes ADD CONSTRAINT reason_codes_category_check CHECK (
    category IN ('administrator', 'session', 'device', 'account', 'security', 'official_agent')
);

INSERT INTO reason_codes (code, category, label, active, created_at, updated_at, revision) VALUES
    ('official_content_review', 'official_agent', '官方智能体内容审核', TRUE, now(), now(), 1),
    ('official_rollout_change', 'official_agent', '官方智能体灰度调整', TRUE, now(), now(), 1),
    ('official_release_pause', 'official_agent', '官方智能体发布暂停', TRUE, now(), now(), 1),
    ('official_release_rollback', 'official_agent', '官方智能体版本回滚', TRUE, now(), now(), 1);

CREATE TABLE official_agent_rollback_requests (
    id UUID PRIMARY KEY,
    release_id UUID NOT NULL,
    target_version_id UUID NOT NULL,
    target_release_revision_id UUID NOT NULL,
    expected_head_revision BIGINT NOT NULL,
    target_digest BYTEA NOT NULL,
    requested_by_admin_id UUID NOT NULL REFERENCES admin_users(id) ON DELETE RESTRICT,
    reviewed_by_admin_id UUID REFERENCES admin_users(id) ON DELETE RESTRICT,
    reason_code TEXT NOT NULL REFERENCES reason_codes(code) ON DELETE RESTRICT,
    ticket_reference TEXT,
    safe_note TEXT,
    approval_status TEXT NOT NULL,
    execution_status TEXT NOT NULL,
    operation_id UUID UNIQUE,
    expires_at TIMESTAMPTZ NOT NULL,
    reviewed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    version BIGINT NOT NULL,
    CONSTRAINT official_agent_rollback_requests_revision_check CHECK (expected_head_revision > 0),
    CONSTRAINT official_agent_rollback_requests_digest_check CHECK (octet_length(target_digest) = 32),
    CONSTRAINT official_agent_rollback_requests_reason_check CHECK (
        reason_code ~ '^[a-z][a-z0-9_]{2,63}$'
    ),
    CONSTRAINT official_agent_rollback_requests_ticket_check CHECK (
        ticket_reference IS NULL OR char_length(ticket_reference) BETWEEN 1 AND 128
    ),
    CONSTRAINT official_agent_rollback_requests_note_check CHECK (
        safe_note IS NULL OR char_length(safe_note) BETWEEN 1 AND 500
    ),
    CONSTRAINT official_agent_rollback_requests_approval_status_check CHECK (
        approval_status IN ('pending_review', 'approved', 'rejected', 'cancelled', 'expired')
    ),
    CONSTRAINT official_agent_rollback_requests_execution_status_check CHECK (
        execution_status IN ('not_started', 'queued', 'executing', 'reconciling', 'succeeded', 'failed', 'conflict')
    ),
    CONSTRAINT official_agent_rollback_requests_reviewer_check CHECK (
        reviewed_by_admin_id IS NULL OR reviewed_by_admin_id <> requested_by_admin_id
    ),
    CONSTRAINT official_agent_rollback_requests_review_state_check CHECK (
        (approval_status = 'pending_review' AND reviewed_by_admin_id IS NULL AND reviewed_at IS NULL) OR
        (approval_status IN ('approved', 'rejected') AND reviewed_by_admin_id IS NOT NULL AND reviewed_at IS NOT NULL) OR
        (approval_status IN ('cancelled', 'expired') AND reviewed_by_admin_id IS NULL AND reviewed_at IS NULL)
    ),
    CONSTRAINT official_agent_rollback_requests_execution_operation_check CHECK (
        (execution_status = 'not_started' AND operation_id IS NULL) OR
        (execution_status <> 'not_started' AND approval_status = 'approved' AND operation_id IS NOT NULL)
    ),
    CONSTRAINT official_agent_rollback_requests_expiry_check CHECK (expires_at > created_at),
    CONSTRAINT official_agent_rollback_requests_timestamps_check CHECK (
        updated_at >= created_at AND (reviewed_at IS NULL OR reviewed_at >= created_at)
    ),
    CONSTRAINT official_agent_rollback_requests_version_check CHECK (version > 0)
);

CREATE INDEX official_agent_rollback_requests_status_created_idx
    ON official_agent_rollback_requests (approval_status, created_at DESC, id);

CREATE INDEX official_agent_rollback_requests_release_created_idx
    ON official_agent_rollback_requests (release_id, created_at DESC, id);

CREATE TABLE official_agent_rollback_events (
    id UUID PRIMARY KEY,
    rollback_request_id UUID NOT NULL
        REFERENCES official_agent_rollback_requests(id) ON DELETE RESTRICT,
    event_type TEXT NOT NULL,
    actor_admin_id UUID NOT NULL REFERENCES admin_users(id) ON DELETE RESTRICT,
    actor_role TEXT NOT NULL,
    approval_status TEXT NOT NULL,
    execution_status TEXT NOT NULL,
    operation_id UUID,
    error_code TEXT,
    created_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT official_agent_rollback_events_type_check CHECK (
        event_type IN (
            'requested', 'approved', 'rejected', 'cancelled', 'expired',
            'queued', 'executing', 'reconciling', 'succeeded', 'failed', 'conflict'
        )
    ),
    CONSTRAINT official_agent_rollback_events_role_check CHECK (
        actor_role IN ('super_admin', 'developer', 'operator', 'support', 'finance', 'auditor')
    ),
    CONSTRAINT official_agent_rollback_events_approval_status_check CHECK (
        approval_status IN ('pending_review', 'approved', 'rejected', 'cancelled', 'expired')
    ),
    CONSTRAINT official_agent_rollback_events_execution_status_check CHECK (
        execution_status IN ('not_started', 'queued', 'executing', 'reconciling', 'succeeded', 'failed', 'conflict')
    ),
    CONSTRAINT official_agent_rollback_events_error_check CHECK (
        error_code IS NULL OR error_code ~ '^[A-Z][A-Z0-9_]{2,99}$'
    )
);

CREATE INDEX official_agent_rollback_events_request_created_idx
    ON official_agent_rollback_events (rollback_request_id, created_at, id);

CREATE FUNCTION reject_official_agent_rollback_event_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'official Agent rollback events are append-only' USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER official_agent_rollback_events_append_only
    BEFORE UPDATE OR DELETE ON official_agent_rollback_events
    FOR EACH ROW EXECUTE FUNCTION reject_official_agent_rollback_event_mutation();

REVOKE UPDATE, DELETE, TRUNCATE ON official_agent_rollback_events FROM PUBLIC;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aera_admin_runtime') THEN
        EXECUTE format(
            'GRANT SELECT, INSERT ON %I.official_agent_rollback_events TO aera_admin_runtime',
            current_schema()
        );
        EXECUTE format(
            'REVOKE UPDATE, DELETE, TRUNCATE ON %I.official_agent_rollback_events FROM aera_admin_runtime',
            current_schema()
        );
    END IF;
END;
$$;
