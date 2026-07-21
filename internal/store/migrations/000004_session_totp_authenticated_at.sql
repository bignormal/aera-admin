ALTER TABLE admin_sessions
    ADD COLUMN totp_authenticated_at TIMESTAMPTZ;

UPDATE admin_sessions
SET totp_authenticated_at = mfa_authenticated_at
WHERE mfa_method = 'totp';

ALTER TABLE admin_sessions
    ADD CONSTRAINT admin_sessions_totp_time_check CHECK (
        totp_authenticated_at IS NULL OR
        (totp_authenticated_at >= created_at AND totp_authenticated_at <= absolute_expires_at)
    );
