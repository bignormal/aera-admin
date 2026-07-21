CREATE TABLE approval_requests (
    id UUID PRIMARY KEY,
    action TEXT NOT NULL,
    target_type TEXT NOT NULL DEFAULT 'cloud_user',
    target_user_id UUID NOT NULL,
    target_snapshot JSONB NOT NULL,
    requested_by_admin_id UUID NOT NULL REFERENCES admin_users(id) ON DELETE RESTRICT,
    requested_by_role TEXT NOT NULL,
    reviewed_by_admin_id UUID REFERENCES admin_users(id) ON DELETE RESTRICT,
    reason_code TEXT NOT NULL REFERENCES reason_codes(code) ON DELETE RESTRICT,
    ticket_reference TEXT,
    note TEXT,
    expected_revision BIGINT NOT NULL,
    approval_status TEXT NOT NULL,
    execution_status TEXT NOT NULL,
    operation_id UUID UNIQUE,
    expires_at TIMESTAMPTZ NOT NULL,
    reviewed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    version BIGINT NOT NULL,
    CONSTRAINT approval_requests_action_check CHECK (action IN ('disable_user', 'enable_user')),
    CONSTRAINT approval_requests_target_type_check CHECK (target_type = 'cloud_user'),
    CONSTRAINT approval_requests_role_check CHECK (requested_by_role = 'operator'),
    CONSTRAINT approval_requests_reason_check CHECK (char_length(btrim(reason_code)) BETWEEN 3 AND 64),
    CONSTRAINT approval_requests_ticket_check CHECK (
        ticket_reference IS NULL OR char_length(ticket_reference) BETWEEN 1 AND 128
    ),
    CONSTRAINT approval_requests_note_check CHECK (note IS NULL OR char_length(note) BETWEEN 1 AND 500),
    CONSTRAINT approval_requests_revision_check CHECK (expected_revision > 0),
    CONSTRAINT approval_requests_approval_status_check CHECK (
        approval_status IN ('pending_review', 'approved', 'rejected', 'expired', 'cancelled')
    ),
    CONSTRAINT approval_requests_execution_status_check CHECK (
        execution_status IN ('not_started', 'queued', 'executing', 'reconciling', 'succeeded', 'failed', 'conflict')
    ),
    CONSTRAINT approval_requests_snapshot_check CHECK (jsonb_typeof(target_snapshot) = 'object'),
    CONSTRAINT approval_requests_reviewer_check CHECK (
        reviewed_by_admin_id IS NULL OR reviewed_by_admin_id <> requested_by_admin_id
    ),
    CONSTRAINT approval_requests_review_state_check CHECK (
        (approval_status = 'pending_review' AND reviewed_by_admin_id IS NULL AND reviewed_at IS NULL) OR
        (approval_status IN ('approved', 'rejected') AND reviewed_by_admin_id IS NOT NULL AND reviewed_at IS NOT NULL) OR
        (approval_status IN ('expired', 'cancelled') AND reviewed_by_admin_id IS NULL AND reviewed_at IS NULL)
    ),
    CONSTRAINT approval_requests_execution_operation_check CHECK (
        (execution_status = 'not_started' AND operation_id IS NULL) OR
        (execution_status <> 'not_started' AND approval_status = 'approved' AND operation_id IS NOT NULL)
    ),
    CONSTRAINT approval_requests_expiry_check CHECK (expires_at > created_at),
    CONSTRAINT approval_requests_timestamps_check CHECK (
        updated_at >= created_at AND (reviewed_at IS NULL OR reviewed_at >= created_at)
    ),
    CONSTRAINT approval_requests_version_check CHECK (version > 0)
);

CREATE UNIQUE INDEX approval_requests_one_pending_target_action
    ON approval_requests (target_user_id, action)
    WHERE approval_status = 'pending_review';

CREATE INDEX approval_requests_status_created_idx
    ON approval_requests (approval_status, created_at DESC, id);

CREATE INDEX approval_requests_requester_created_idx
    ON approval_requests (requested_by_admin_id, created_at DESC, id);

CREATE TABLE approval_events (
    id UUID PRIMARY KEY,
    approval_request_id UUID NOT NULL REFERENCES approval_requests(id) ON DELETE RESTRICT,
    actor_admin_id UUID NOT NULL REFERENCES admin_users(id) ON DELETE RESTRICT,
    actor_role TEXT NOT NULL,
    event_type TEXT NOT NULL,
    before_status TEXT NOT NULL,
    after_status TEXT NOT NULL,
    result_code TEXT,
    request_id TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT approval_events_role_check CHECK (
        actor_role IN ('super_admin', 'developer', 'operator', 'support', 'finance', 'auditor')
    ),
    CONSTRAINT approval_events_type_check CHECK (
        event_type IN (
            'created', 'approved', 'rejected', 'cancelled', 'expired',
            'execution_queued', 'execution_started', 'execution_reconciling',
            'execution_succeeded', 'execution_failed', 'execution_conflict'
        )
    ),
    CONSTRAINT approval_events_before_check CHECK (
        before_status = '' OR before_status IN (
            'pending_review', 'approved', 'rejected', 'expired', 'cancelled',
            'not_started', 'queued', 'executing', 'reconciling', 'succeeded', 'failed', 'conflict'
        )
    ),
    CONSTRAINT approval_events_after_check CHECK (
        after_status IN (
            'pending_review', 'approved', 'rejected', 'expired', 'cancelled',
            'not_started', 'queued', 'executing', 'reconciling', 'succeeded', 'failed', 'conflict'
        )
    ),
    CONSTRAINT approval_events_result_check CHECK (
        result_code IS NULL OR result_code ~ '^[A-Z][A-Z0-9_]{2,99}$'
    ),
    CONSTRAINT approval_events_request_check CHECK (char_length(request_id) BETWEEN 1 AND 128)
);

CREATE INDEX approval_events_request_created_idx
    ON approval_events (approval_request_id, created_at, id);

CREATE TABLE admin_idempotency_records (
    operation_id UUID PRIMARY KEY,
    actor_admin_id UUID NOT NULL REFERENCES admin_users(id) ON DELETE RESTRICT,
    action TEXT NOT NULL,
    idempotency_key_hmac BYTEA NOT NULL,
    request_hash BYTEA NOT NULL,
    state TEXT NOT NULL,
    error_code TEXT,
    result JSONB,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    completed_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT admin_idempotency_actor_key UNIQUE (actor_admin_id, action, idempotency_key_hmac),
    CONSTRAINT admin_idempotency_action_check CHECK (
        action IN ('revoke_device', 'revoke_session', 'disable_user', 'enable_user')
    ),
    CONSTRAINT admin_idempotency_key_length_check CHECK (octet_length(idempotency_key_hmac) = 32),
    CONSTRAINT admin_idempotency_request_length_check CHECK (octet_length(request_hash) = 32),
    CONSTRAINT admin_idempotency_state_check CHECK (
        state IN ('queued', 'executing', 'reconciling', 'succeeded', 'failed', 'conflict')
    ),
    CONSTRAINT admin_idempotency_error_check CHECK (
        error_code IS NULL OR error_code ~ '^[A-Z][A-Z0-9_]{2,99}$'
    ),
    CONSTRAINT admin_idempotency_result_check CHECK (result IS NULL OR jsonb_typeof(result) = 'object'),
    CONSTRAINT admin_idempotency_timestamps_check CHECK (
        updated_at >= created_at AND expires_at > created_at AND
        (completed_at IS NULL OR completed_at >= created_at)
    )
);

CREATE INDEX admin_idempotency_expiry_idx
    ON admin_idempotency_records (expires_at, operation_id);

CREATE TABLE admin_outbox (
    operation_id UUID PRIMARY KEY REFERENCES admin_idempotency_records(operation_id) ON DELETE RESTRICT,
    action TEXT NOT NULL,
    target_id UUID NOT NULL,
    approval_id UUID REFERENCES approval_requests(id) ON DELETE RESTRICT,
    actor_admin_id UUID NOT NULL REFERENCES admin_users(id) ON DELETE RESTRICT,
    actor_role TEXT NOT NULL,
    idempotency_key_hmac BYTEA NOT NULL,
    expected_revision BIGINT NOT NULL,
    reason_code TEXT NOT NULL REFERENCES reason_codes(code) ON DELETE RESTRICT,
    ticket_reference TEXT,
    note TEXT,
    request_id TEXT NOT NULL,
    status TEXT NOT NULL,
    attempts INTEGER NOT NULL,
    available_at TIMESTAMPTZ NOT NULL,
    lease_until TIMESTAMPTZ,
    last_error_code TEXT,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    completed_at TIMESTAMPTZ,
    CONSTRAINT admin_outbox_action_check CHECK (
        action IN ('revoke_device', 'revoke_session', 'disable_user', 'enable_user')
    ),
    CONSTRAINT admin_outbox_revision_check CHECK (expected_revision > 0),
    CONSTRAINT admin_outbox_role_check CHECK (
        actor_role IN ('super_admin', 'developer', 'operator', 'support', 'finance', 'auditor')
    ),
    CONSTRAINT admin_outbox_key_length_check CHECK (octet_length(idempotency_key_hmac) = 32),
    CONSTRAINT admin_outbox_ticket_check CHECK (
        ticket_reference IS NULL OR char_length(ticket_reference) BETWEEN 1 AND 128
    ),
    CONSTRAINT admin_outbox_note_check CHECK (note IS NULL OR char_length(note) BETWEEN 1 AND 500),
    CONSTRAINT admin_outbox_request_check CHECK (char_length(request_id) BETWEEN 1 AND 128),
    CONSTRAINT admin_outbox_status_check CHECK (
        status IN ('queued', 'executing', 'reconciling', 'succeeded', 'failed', 'conflict')
    ),
    CONSTRAINT admin_outbox_attempts_check CHECK (attempts >= 0),
    CONSTRAINT admin_outbox_error_check CHECK (
        last_error_code IS NULL OR last_error_code ~ '^[A-Z][A-Z0-9_]{2,99}$'
    ),
    CONSTRAINT admin_outbox_timestamps_check CHECK (
        updated_at >= created_at AND available_at >= created_at AND
        (lease_until IS NULL OR lease_until >= updated_at) AND
        (completed_at IS NULL OR completed_at >= created_at)
    )
);

CREATE INDEX admin_outbox_claim_idx
    ON admin_outbox (available_at, created_at, operation_id)
    WHERE status IN ('queued', 'reconciling');

CREATE FUNCTION reject_approval_event_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'approval events are append-only' USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER approval_events_append_only
    BEFORE UPDATE OR DELETE ON approval_events
    FOR EACH ROW EXECUTE FUNCTION reject_approval_event_mutation();

REVOKE UPDATE, DELETE, TRUNCATE ON approval_events FROM PUBLIC;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aera_admin_runtime') THEN
        EXECUTE format('GRANT SELECT, INSERT ON %I.approval_events TO aera_admin_runtime', current_schema());
        EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON %I.approval_events FROM aera_admin_runtime', current_schema());
    END IF;
END;
$$;
