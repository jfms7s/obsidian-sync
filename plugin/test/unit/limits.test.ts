// The protocol limits the plugin mirrors must equal the server's
// (server/internal/limits, written to vectors/limits.json by make vectors).
// Client-only values are not here: COMMIT_BATCH_BYTES (cut below the body
// limit on purpose) and DEFAULT_MAX_FILE_BYTES (this device's own choice).
import { expect, it } from 'vitest';
import * as L from '../../src/api/limits';
import { ARGON2_LIMITS } from '../../src/crypto/userkeys';
import { loadVectors } from '../helpers/vectors';

it('mirrors every protocol limit of the server exactly', () => {
  const server = loadVectors<Record<string, number>>('limits.json');
  expect({
    chunk_size: L.CHUNK_SIZE,
    max_commits_per_request: L.MAX_COMMITS_PER_REQUEST,
    commit_body_limit: L.COMMIT_BODY_LIMIT,
    max_enc_meta_bytes: L.MAX_ENC_META_BYTES,
    max_chunk_exists_batch: L.MAX_CHUNK_EXISTS_BATCH,
    // The client asks for the largest pages the server serves.
    max_page_size: L.CHANGES_PAGE_SIZE,
    max_heads_page_size: L.HEADS_PAGE_SIZE,
    max_password_bytes: L.MAX_PASSWORD_BYTES,
    login_body_limit: L.LOGIN_BODY_LIMIT,
    min_argon2_memory_kib: ARGON2_LIMITS.minMemoryKib,
    max_argon2_memory_kib: ARGON2_LIMITS.maxMemoryKib,
    max_argon2_iterations: ARGON2_LIMITS.maxIterations,
    max_argon2_parallelism: ARGON2_LIMITS.maxParallelism,
  }).toEqual(server);
  expect(L.COMMIT_BATCH_BYTES).toBeLessThan(L.COMMIT_BODY_LIMIT);
});
