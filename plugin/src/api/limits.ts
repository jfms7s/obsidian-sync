// Protocol limits enforced by the server (server/internal/api/codec.go,
// server/internal/syncsvc/service.go). The client stays inside them.
export const CHUNK_SIZE = 4 << 20;
export const MAX_COMMITS_PER_REQUEST = 500;
export const COMMIT_BODY_LIMIT = 8 << 20;
/** Batches are cut below the limit to leave room for framing. */
export const COMMIT_BATCH_BYTES = 7 << 20;
export const MAX_CHUNK_EXISTS_BATCH = 1000;
export const MAX_ENC_META_BYTES = 64 << 10;
export const CHANGES_PAGE_SIZE = 1000;
export const HEADS_PAGE_SIZE = 5000;
export const MAX_PASSWORD_BYTES = 1024;
export const LOGIN_BODY_LIMIT = 16 << 10;
