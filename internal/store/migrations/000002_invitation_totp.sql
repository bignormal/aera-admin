ALTER TABLE admin_invitations
    ADD COLUMN purpose TEXT NOT NULL DEFAULT 'activation',
    ADD COLUMN totp_encryption_key_id TEXT,
    ADD COLUMN totp_nonce BYTEA,
    ADD COLUMN totp_ciphertext BYTEA,
    ADD CONSTRAINT admin_invitations_purpose_check CHECK (purpose IN ('activation', 'totp_reset'));

-- Invitations issued before encrypted pending TOTP material existed cannot be
-- completed safely. Invalidate them explicitly so operators can reissue them.
UPDATE admin_invitations
SET consumed_at = GREATEST(created_at, CURRENT_TIMESTAMP)
WHERE consumed_at IS NULL;

ALTER TABLE admin_invitations
    ADD CONSTRAINT admin_invitations_totp_secret_check CHECK (
        (
            consumed_at IS NULL AND
            num_nonnulls(totp_encryption_key_id, totp_nonce, totp_ciphertext) = 3 AND
            char_length(btrim(totp_encryption_key_id)) BETWEEN 1 AND 100 AND
            octet_length(totp_nonce) = 12 AND
            octet_length(totp_ciphertext) > 16
        ) OR (
            consumed_at IS NOT NULL AND
            num_nonnulls(totp_encryption_key_id, totp_nonce, totp_ciphertext) = 0
        )
    );
