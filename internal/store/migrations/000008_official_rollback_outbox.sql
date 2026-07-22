ALTER TABLE admin_outbox
    ADD COLUMN official_rollback_request_id UUID
        REFERENCES official_agent_rollback_requests(id) ON DELETE RESTRICT,
    ADD CONSTRAINT admin_outbox_single_approval_check CHECK (
        num_nonnulls(approval_id, official_rollback_request_id) <= 1
    );

CREATE INDEX admin_outbox_official_rollback_request_idx
    ON admin_outbox (official_rollback_request_id)
    WHERE official_rollback_request_id IS NOT NULL;
