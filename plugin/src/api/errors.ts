import { ErrorCode } from '../gen/obsync/v1/obsync_pb';

export { ErrorCode };

/** The server answered with an error (a protobuf Error, or an HTTP status from a proxy). */
export class ApiError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly status: number,
    /** From Retry-After, when the server sent one. */
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** The request never got an answer: offline, DNS, TLS, reset, or a body cut off mid-stream. */
export class NetworkError extends Error {
  constructor(message: string, override readonly cause?: unknown) {
    super(message);
    this.name = 'NetworkError';
  }
}

/** A response body that ended early (shorter than Content-Length, or the connection broke mid-body). */
export class TruncatedBodyError extends NetworkError {
  constructor(message: string, cause?: unknown) {
    super(message, cause);
    this.name = 'TruncatedBodyError';
  }
}

/**
 * The server says the vault is gone or this account lost access to it. The
 * protocol has no separate code for this: chunk and vault lookups both
 * answer NOT_FOUND, told apart by the server's message ("vault not found",
 * "chunk not found"; server/internal/syncsvc).
 */
export function isVaultNotFound(err: unknown): boolean {
  return err instanceof ApiError && err.code === ErrorCode.NOT_FOUND && /\bvault not found\b/i.test(err.message);
}

/** Errors worth retrying later without anyone acting. */
export function isTemporary(err: unknown): boolean {
  if (err instanceof NetworkError) return true;
  if (err instanceof ApiError) {
    return err.code === ErrorCode.RATE_LIMITED || err.code === ErrorCode.INTERNAL || err.status >= 500;
  }
  return false;
}

/** Errors after which this device must stop syncing until the user logs in again. */
export function isAuthFailure(err: unknown): boolean {
  return err instanceof ApiError && (err.code === ErrorCode.DEVICE_REVOKED || err.code === ErrorCode.UNAUTHORIZED);
}

export function errorCodeName(code: ErrorCode): string {
  return ErrorCode[code] ?? `ERROR_${code}`;
}
