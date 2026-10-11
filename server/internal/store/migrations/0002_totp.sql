-- 0002_totp: optional TOTP second factor per account.
-- Nullable columns and a new table only, so a 0.1.x binary (whose migration
-- runner skips versions it does not know) still starts on this schema. Such
-- a binary does not check the second factor, though.
-- totp_secret NULL means TOTP is off; totp_pending_secret holds a secret
-- between enrolment begin and confirm (from totp_pending_at, Unix ms, for a
-- limited time); totp_last_step is the last accepted
-- time step, so a code works once.

ALTER TABLE users ADD COLUMN totp_secret BLOB;

ALTER TABLE users ADD COLUMN totp_pending_secret BLOB;

ALTER TABLE users ADD COLUMN totp_last_step INTEGER;

ALTER TABLE users ADD COLUMN totp_pending_at INTEGER;

CREATE TABLE totp_recovery_codes (
    user_id   TEXT NOT NULL,
    code_hash BLOB NOT NULL,
    used_at   INTEGER,
    PRIMARY KEY (user_id, code_hash)
);
