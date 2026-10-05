import { IDBFactory } from 'fake-indexeddb';
import { expect, it } from 'vitest';
import type { ApiClient } from '../../src/api/client';
import { ApiError, ErrorCode, NetworkError } from '../../src/api/errors';
import { CryptoError } from '../../src/crypto/primitives';
import { buildKeyring, epochKeys, MissingEpochKeyError } from '../../src/crypto/vaultkeys';
import { LocalState } from '../../src/state/store';
import { DEFAULT_MAX_FILE_BYTES, ServerRollbackError, type SyncContext } from '../../src/sync/context';
import type { EngineEvent } from '../../src/sync/events';
import { clearFailure, FileSyncError, isCycleError, isDeferred, nextRetryAt, recordFailure } from '../../src/sync/failures';
import { ManualClock } from '../../src/util/clock';
import { seededRandom } from '../../src/util/random';
import { IgnoreRules } from '../../src/vault/ignore';
import { MemoryAdapter } from '../../src/vault/memory';

async function ctx(): Promise<SyncContext & { events: EngineEvent[]; clock: ManualClock }> {
  const r = seededRandom(1);
  const clock = new ManualClock(0);
  const events: EngineEvent[] = [];
  return {
    api: {} as ApiClient, state: await LocalState.open(new IDBFactory(), 'f'), adapter: new MemoryAdapter(), deviceName: 'd',
    ring: await buildKeyring('0123456789abcdef0123456789abcdef', r.bytes(32), new Map([[1, r.bytes(32)]]), 1),
    clock, random: r, ignore: new IgnoreRules(), maxFileBytes: DEFAULT_MAX_FILE_BYTES, emit: (e) => events.push(e), events,
  };
}

it('backs off a failing file from 1 minute, notifying only the first time', async () => {
  const c = await ctx();
  await recordFailure(c, 'push:a.md', 'a.md', new Error('EIO'));
  expect(await isDeferred(c, 'push:a.md')).toBe(true);
  const first = (await c.state.getFailure('push:a.md'))!;
  expect(first.nextAt).toBeGreaterThanOrEqual(30_000);
  expect(first.nextAt).toBeLessThan(60_000);
  c.clock.advance(60_000);
  expect(await isDeferred(c, 'push:a.md')).toBe(false);
  await recordFailure(c, 'push:a.md', 'a.md', new Error('EIO'));
  expect((await c.state.getFailure('push:a.md'))!.attempts).toBe(2);
  expect(c.events).toEqual([{ type: 'notice', code: 'FILE_FAILED', persistent: false, path: 'a.md', message: 'a.md: EIO' }]);
  expect(await nextRetryAt(c)).toBe((await c.state.getFailure('push:a.md'))!.nextAt);
  await clearFailure(c, 'push:a.md');
  expect(await nextRetryAt(c)).toBeNull();
});

it('uses the error to pick the notice code', async () => {
  const c = await ctx();
  await recordFailure(c, 'apply:1', 'x.md', new CryptoError('bad'));
  await recordFailure(c, 'apply:2', 'y.md', new FileSyncError('CONTENT_MISSING', 'gone'));
  expect(c.events.map((e) => (e as { code: string }).code)).toEqual(['DECRYPT_FAILED', 'CONTENT_MISSING']);
});

it('separates cycle errors from per-file errors', () => {
  expect(isCycleError(new NetworkError('down'))).toBe(true);
  expect(isCycleError(new ApiError(ErrorCode.INTERNAL, 'x', 500))).toBe(true);
  expect(isCycleError(new ServerRollbackError(5, 3))).toBe(true);
  expect(isCycleError(new Error('EIO'))).toBe(false);
  expect(isCycleError(new CryptoError('bad'))).toBe(false);
});

it('fails the cycle on programming errors, IndexedDB errors and a missing epoch key', async () => {
  expect(isCycleError(new TypeError('x is undefined'))).toBe(true);
  expect(isCycleError(new RangeError('bad length'))).toBe(true);
  const st = await LocalState.open(new IDBFactory(), 'closed');
  st.close();
  const idbErr = await st.getFile('aa').catch((e: unknown) => e);
  expect(idbErr).toBeInstanceOf(DOMException);
  expect(isCycleError(idbErr)).toBe(true);
  const ring = await buildKeyring('0123456789abcdef0123456789abcdef', new Uint8Array(32), new Map([[1, new Uint8Array(32)]]), 1);
  const missing = (() => { try { epochKeys(ring, 2); } catch (e) { return e; } })();
  expect(missing).toBeInstanceOf(MissingEpochKeyError);
  expect(missing).toBeInstanceOf(CryptoError);
  expect(isCycleError(missing)).toBe(true);
  expect(isCycleError(new CryptoError('bad'))).toBe(false);
});
