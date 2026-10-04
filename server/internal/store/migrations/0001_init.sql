-- 0001_init: core sync schema.
-- No FOREIGN KEY clauses: PRAGMA foreign_keys is per connection and cannot be
-- relied on over remote libSQL, so the store deletes dependent rows itself.
-- One statement per ';'-terminated line group: go-libsql's Exec runs only the
-- first statement of a string, so migrate.go splits this file.

CREATE TABLE users (
    id            TEXT PRIMARY KEY,
    username      TEXT NOT NULL COLLATE NOCASE UNIQUE,
    password_hash TEXT NOT NULL,
    quota_bytes   INTEGER NOT NULL,
    created_at    INTEGER NOT NULL
);

CREATE TABLE devices (
    id           TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL,
    token_hash   BLOB NOT NULL UNIQUE,
    name         TEXT NOT NULL,
    platform     TEXT NOT NULL,
    created_at   INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    revoked_at   INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX devices_user ON devices (user_id);

CREATE TABLE key_bundles (
    user_id         TEXT PRIMARY KEY,
    public_enc_key  BLOB NOT NULL,
    public_sign_key BLOB NOT NULL,
    bundle          BLOB NOT NULL,
    updated_at      INTEGER NOT NULL
);

CREATE TABLE vaults (
    id            TEXT PRIMARY KEY,
    owner_id      TEXT NOT NULL,
    enc_name      BLOB NOT NULL,
    seq           INTEGER NOT NULL DEFAULT 0,
    current_epoch INTEGER NOT NULL DEFAULT 1,
    bytes_used    INTEGER NOT NULL DEFAULT 0,
    created_at    INTEGER NOT NULL
);

CREATE INDEX vaults_owner ON vaults (owner_id);

CREATE TABLE vault_members (
    vault_id TEXT NOT NULL,
    user_id  TEXT NOT NULL,
    role     TEXT NOT NULL,
    PRIMARY KEY (vault_id, user_id)
);

CREATE INDEX vault_members_user ON vault_members (user_id);

CREATE TABLE vault_keys (
    vault_id   TEXT NOT NULL,
    user_id    TEXT NOT NULL,
    epoch      INTEGER NOT NULL,
    sealed_key BLOB NOT NULL,
    PRIMARY KEY (vault_id, user_id, epoch)
);

CREATE TABLE files (
    vault_id        TEXT NOT NULL,
    file_id         BLOB NOT NULL,
    head_version_id BLOB NOT NULL,
    PRIMARY KEY (vault_id, file_id)
);

CREATE TABLE versions (
    vault_id        TEXT NOT NULL,
    version_id      BLOB NOT NULL,
    file_id         BLOB NOT NULL,
    base_version_id BLOB NOT NULL,
    epoch           INTEGER NOT NULL,
    enc_meta        BLOB NOT NULL,
    size            INTEGER NOT NULL,
    deleted         INTEGER NOT NULL,
    device_id       TEXT NOT NULL,
    created_at      INTEGER NOT NULL,
    seq             INTEGER NOT NULL,
    PRIMARY KEY (vault_id, version_id)
);

CREATE UNIQUE INDEX versions_seq ON versions (vault_id, seq);

CREATE INDEX versions_file ON versions (vault_id, file_id, seq);

CREATE INDEX versions_created ON versions (created_at);

CREATE TABLE version_chunks (
    vault_id   TEXT NOT NULL,
    version_id BLOB NOT NULL,
    idx        INTEGER NOT NULL,
    chunk_id   BLOB NOT NULL,
    PRIMARY KEY (vault_id, version_id, idx)
);

CREATE INDEX version_chunks_chunk ON version_chunks (vault_id, chunk_id);

CREATE TABLE chunks (
    vault_id   TEXT NOT NULL,
    chunk_id   BLOB NOT NULL,
    blob_key   TEXT NOT NULL,
    size       INTEGER NOT NULL,
    touched_at INTEGER NOT NULL,
    PRIMARY KEY (vault_id, chunk_id)
);

CREATE INDEX chunks_touched ON chunks (touched_at);

CREATE TABLE job_leases (
    name       TEXT PRIMARY KEY,
    holder     TEXT NOT NULL,
    expires_at INTEGER NOT NULL
);
