// The plugin engine's public surface, used by the Obsidian integration (plan 3).
export { ApiClient, setDefaultTransport, type FetchLike, type HttpRequest, type HttpResponse } from './api/client';
export { ApiError, ErrorCode, NetworkError, TruncatedBodyError, errorCodeName, isAuthFailure, isTemporary } from './api/errors';
export { defaultWebSocketFactory, type WebSocketFactory, type WebSocketLike } from './api/hub';
export { InsecureServerUrlError, normalizeServerUrl } from './api/url';
export type { DeviceInfo } from './api/types';
export { CryptoError } from './crypto/primitives';
export { Argon2TooCostlyError, DEFAULT_ARGON2, InvalidRecoveryWordsError, type UserKeys } from './crypto/userkeys';
export { MissingEpochKeyError } from './crypto/vaultkeys';
export { merge3, type MergeResult } from './merge/merge3';
export { LocalState, type Session, type StoredVault } from './state/store';
export { DEFAULT_MAX_FILE_BYTES } from './sync/context';
export { DEBOUNCE_MAX_WAIT_MS, SyncEngine, type EngineOptions } from './sync/engine';
export type { EngineEvent, NoticeCode, SyncStatus } from './sync/events';
export { systemClock, type Clock } from './util/clock';
export { cryptoRandom, type Random } from './util/random';
export { CONFLICT_COPY_PATTERN, normalizePath } from './util/path';
export { expectFor, type AdapterEvent, type Expect, type FileStat, type VaultAdapter } from './vault/adapter';
export { DEFAULT_IGNORES, IgnoreRules, InvalidIgnorePatternError, validateIgnorePattern } from './vault/ignore';
// In-memory adapter for tests and tooling, not for real vaults.
export { MemoryAdapter } from './vault/memory';
export * as account from './services/account';
export { SetupPassphraseMismatchError } from './services/account';
export * as history from './services/history';
export { NotInTrashError, PathOccupiedError, UnsyncedChangesError } from './services/history';
export * as vaults from './services/vaults';
export { openSyncSession, type SyncSessionOptions, type SyncSessionResult } from './services/session';
