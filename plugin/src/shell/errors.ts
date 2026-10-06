// Turns the errors the engine and services throw into text for the settings tab and notices.
import { ApiError, ErrorCode, NetworkError } from '../api/errors';
import { InsecureServerUrlError } from '../api/url';
import { CryptoError } from '../crypto/primitives';
import { Argon2TooCostlyError, InvalidRecoveryWordsError } from '../crypto/userkeys';
import { MissingEpochKeyError } from '../crypto/vaultkeys';
import { KeysAlreadySetUpError, SetupPassphraseMismatchError } from '../services/account';
import { NotInTrashError, PathOccupiedError, UnsyncedChangesError } from '../services/history';

export interface UserError {
  message: string;
  /** What helps: try again, sign in again, change what was typed, or nothing the user can do now. */
  kind: 'retry' | 'login' | 'fix-input' | 'none';
}

function apiMessage(err: ApiError): UserError {
  switch (err.code) {
    case ErrorCode.UNAUTHORIZED:
      return { kind: 'login', message: 'The server did not accept this device or those credentials. Sign in again.' };
    case ErrorCode.DEVICE_REVOKED:
      return { kind: 'login', message: 'This device was removed from your account. Sign in again.' };
    case ErrorCode.WRONG_PASSWORD:
      return { kind: 'fix-input', message: 'The account password is wrong.' };
    case ErrorCode.QUOTA_EXCEEDED:
      return { kind: 'none', message: 'The storage quota is used up. Free some space or ask the server\'s administrator.' };
    case ErrorCode.RATE_LIMITED: {
      const s = Math.max(1, Math.ceil((err.retryAfterMs ?? 0) / 1000));
      return { kind: 'retry', message: `Too many requests. Try again in ${s} seconds.` };
    }
    case ErrorCode.TOO_LARGE:
      return { kind: 'none', message: 'The file is too large for the server.' };
    case ErrorCode.STALE_EPOCH:
      return { kind: 'retry', message: 'The vault key changed. Try again.' };
    case ErrorCode.INVALID:
      return { kind: 'fix-input', message: `The server refused this: ${err.message}` };
    default:
      return err.status >= 500 || err.code === ErrorCode.INTERNAL
        ? { kind: 'retry', message: 'The server had a problem. Try again later.' }
        : { kind: 'none', message: `The server answered: ${err.message}` };
  }
}

export function describeError(err: unknown): UserError {
  if (err instanceof ApiError) return apiMessage(err);
  if (err instanceof NetworkError) return { kind: 'retry', message: 'Cannot reach the server. Check the address and your connection.' };
  if (err instanceof InsecureServerUrlError) return { kind: 'fix-input', message: 'The server address must start with https:// (http:// is allowed only for localhost).' };
  // Subclasses of CryptoError first.
  if (err instanceof Argon2TooCostlyError) return { kind: 'none', message: 'This account asks for more memory to unlock than this device allows.' };
  if (err instanceof MissingEpochKeyError) return { kind: 'retry', message: 'This device does not have the key for part of this vault yet.' };
  if (err instanceof CryptoError) return { kind: 'fix-input', message: 'That passphrase does not unlock the account keys.' };
  if (err instanceof InvalidRecoveryWordsError || err instanceof KeysAlreadySetUpError || err instanceof SetupPassphraseMismatchError) {
    return { kind: 'fix-input', message: err.message[0]!.toUpperCase() + err.message.slice(1) + (err.message.endsWith('.') ? '' : '.') };
  }
  if (err instanceof UnsyncedChangesError) return { kind: 'retry', message: `${err.path} has changes that are not synced yet. Wait for the sync to finish, then restore.` };
  if (err instanceof PathOccupiedError || err instanceof NotInTrashError) return { kind: 'none', message: `${err.message}.` }; // they begin with a file name: keep its case
  return { kind: 'none', message: `Something went wrong: ${err instanceof Error ? err.message : String(err)}` };
}
