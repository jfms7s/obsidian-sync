// Per-file failures (spec §7.5 retries, applied to one file at a time).
//
// Policy: an error that concerns one file (a local I/O error, a version
// that fails verification, a chunk the server lost) never stops the rest of
// the vault. The file is skipped, a notice is shown on its first failure,
// and it is retried after an exponential backoff of 1 min doubling to 6 h:
// a pushed path when push next sees its dirty entry, a remote version when
// reconcile next finds its head not applied. The pull cursor moves on.
// Errors that concern the connection or the account (ApiError,
// NetworkError, a server rollback), the device's own state (an IndexedDB
// error, a keyring without the version's epoch key) or a bug (TypeError,
// RangeError) are not per-file: they fail the cycle. A missing epoch key
// that a keyring refresh did not provide either is per-file after all
// (isFileError), so one unreadable version cannot block the vault.
import { ApiError, NetworkError } from '../api/errors';
import { CryptoError } from '../crypto/primitives';
import { MissingEpochKeyError } from '../crypto/vaultkeys';
import { backoffDelay, type BackoffPolicy } from '../util/backoff';
import { ServerRollbackError, type SyncContext } from './context';
import type { NoticeCode } from './events';

export const FAILURE_BACKOFF: BackoffPolicy = { baseMs: 60_000, maxMs: 6 * 3600_000 };

/** A file-specific problem with a notice code for the UI. */
export class FileSyncError extends Error {
  constructor(readonly code: NoticeCode, message: string) {
    super(message);
    this.name = 'FileSyncError';
  }
}

/** Errors that must fail the whole cycle rather than one file. */
export function isCycleError(err: unknown): boolean {
  return (
    err instanceof ApiError || err instanceof NetworkError || err instanceof ServerRollbackError || err instanceof MissingEpochKeyError ||
    err instanceof TypeError || err instanceof RangeError ||
    // IndexedDB reports failures as DOMException; the vault adapter never does.
    (typeof DOMException !== 'undefined' && err instanceof DOMException)
  );
}

/** Whether err, although a cycle error in general, concerns only one file in ctx (see the header). */
export function isFileError(ctx: SyncContext, err: unknown): boolean {
  return !isCycleError(err) || (err instanceof MissingEpochKeyError && !!ctx.unavailableEpochs?.has(err.epoch));
}

export { pushFailureKey as pushKey } from '../state/store';
export const applyKey = (fileId: string) => `apply:${fileId}`;

/** True while key's last failure is still backing off. */
export async function isDeferred(ctx: SyncContext, key: string): Promise<boolean> {
  const f = await ctx.state.getFailure(key);
  return !!f && f.nextAt > ctx.clock.now();
}

export async function clearFailure(ctx: SyncContext, key: string): Promise<void> {
  if (await ctx.state.getFailure(key)) await ctx.state.deleteFailure(key);
}

/** Records a failure of key, schedules its retry and, on the first failure, tells the user. */
export async function recordFailure(ctx: SyncContext, key: string, path: string, err: unknown): Promise<void> {
  const prev = await ctx.state.getFailure(key);
  const attempts = (prev?.attempts ?? 0) + 1;
  const message = err instanceof Error ? err.message : String(err);
  await ctx.state.putFailure({ key, attempts, nextAt: ctx.clock.now() + backoffDelay(attempts - 1, ctx.random, FAILURE_BACKOFF), message });
  if (attempts === 1) {
    const code: NoticeCode = err instanceof FileSyncError ? err.code : err instanceof CryptoError ? 'DECRYPT_FAILED' : 'FILE_FAILED';
    ctx.emit({ type: 'notice', code, persistent: false, path, message: `${path}: ${message}` });
  }
}

/** The earliest time a failed file is due again, or null. */
export async function nextRetryAt(ctx: SyncContext): Promise<number | null> {
  const all = await ctx.state.allFailures();
  return all.length === 0 ? null : Math.min(...all.map((f) => f.nextAt));
}
