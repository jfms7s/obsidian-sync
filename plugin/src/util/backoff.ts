import type { Random } from './random';

export interface BackoffPolicy {
  baseMs: number;
  maxMs: number;
}

export const DEFAULT_BACKOFF: BackoffPolicy = { baseMs: 1000, maxMs: 5 * 60_000 };

/**
 * Exponential backoff with "equal jitter": the delay for attempt n (0-based)
 * is uniformly random in [d/2, d) where d = min(max, base·2^n). A server
 * Retry-After is a floor, never shortened by jitter.
 */
export function backoffDelay(attempt: number, random: Random, policy: BackoffPolicy = DEFAULT_BACKOFF, retryAfterMs = 0): number {
  const d = Math.min(policy.maxMs, policy.baseMs * 2 ** Math.min(attempt, 30));
  return Math.max(retryAfterMs, Math.floor(d / 2 + (random.float() * d) / 2));
}
