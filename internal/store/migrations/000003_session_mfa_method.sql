ALTER TABLE admin_sessions
    ADD COLUMN mfa_method TEXT;

UPDATE admin_sessions
SET mfa_method = 'totp'
WHERE mfa_method IS NULL;

ALTER TABLE admin_sessions
    ALTER COLUMN mfa_method SET NOT NULL,
    ADD CONSTRAINT admin_sessions_mfa_method_check CHECK (mfa_method IN ('totp', 'recovery'));
