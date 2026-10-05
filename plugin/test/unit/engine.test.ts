// The engine's loop with a scripted API and a manual clock: status events,
// backoff with jitter, Retry-After, and the errors that stop sync.
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import type { ApiClient } from '../../src/api/client';
import { ApiError, ErrorCode, NetworkError } from '../../src/api/errors';
import type { ChangesPage, HeadsPage, RemoteVersion } from '../../src/api/types';
import { encryptMeta, fileIdFor } from '../../src/crypto/objects';
import { buildKeyring, epochKeys, MissingEpochKeyError } from '../../src/crypto/vaultkeys';
import { LocalState } from '../../src/state/store';
import { SyncEngine } from '../../src/sync/engine';
import type { EngineEvent } from '../../src/sync/events';
import { toHex } from '../../src/util/bytes';
import { ManualClock } from '../../src/util/clock';
import { seededRandom } from '../../src/util/random';
import { MemoryAdapter } from '../../src/vault/memory';

type Step = ChangesPage | Error;

async function setup(script: Step[], opts: { autoRun?: boolean } = {}) {
  const clock = new ManualClock(0);
  const calls: number[] = [];
  const api = {
    token: undefined,
    baseUrl: 'http://localhost',
    changes: async (_vault: string, since: number): Promise<ChangesPage> => {
      calls.push(clock.now());
      const next = script.shift() ?? { versions: [], vaultSeq: since, more: false };
      if (next instanceof Error) throw next;
      return next;
    },
    heads: async (): Promise<HeadsPage> => ({ heads: [], more: false }),
  } as unknown as ApiClient;
  const r = seededRandom(1);
  const ring = await buildKeyring('0123456789abcdef0123456789abcdef', r.bytes(32), new Map([[1, r.bytes(32)]]), 1);
  const state = await LocalState.open(new IDBFactory(), 'engine');
  const events: EngineEvent[] = [];
  const engine = new SyncEngine({
    api, state, adapter: new MemoryAdapter(false, clock), ring, deviceName: 'd', clock, random: r, webSocket: null,
    autoRun: opts.autoRun ?? true, backoff: { baseMs: 1000, maxMs: 60_000 },
  });
  engine.on((e) => events.push(e));
  const tick = async (ms: number) => {
    clock.advance(ms);
    await engine.whenIdle();
  };
  return { engine, events, calls, tick };
}

const empty: ChangesPage = { versions: [], vaultSeq: 0, more: false };

describe('engine loop', () => {
  it('goes offline on network errors and retries with growing backoff', async () => {
    const { engine, events, calls, tick } = await setup([new NetworkError('down'), new NetworkError('down'), empty, empty]);
    await engine.start();
    await tick(0);
    expect(engine.status).toBe('offline');
    await tick(499);
    expect(calls).toHaveLength(1); // attempt 0 waits 500..1000 ms
    await tick(501);
    expect(calls).toHaveLength(2);
    await tick(2000); // attempt 1 waits 1000..2000 ms
    expect(calls).toHaveLength(3);
    expect(engine.status).toBe('synced');
    expect(events.filter((e) => e.type === 'status').map((e) => (e as { status: string }).status)).toEqual(['syncing', 'offline', 'syncing', 'offline', 'syncing', 'synced']);
    await engine.stop();
  });

  it('waits at least Retry-After after RATE_LIMITED', async () => {
    const { engine, calls, tick } = await setup([new ApiError(ErrorCode.RATE_LIMITED, 'slow down', 429, 30_000), empty, empty]);
    await engine.start();
    await tick(0);
    await tick(29_999);
    expect(calls).toHaveLength(1);
    await tick(1);
    expect(calls).toHaveLength(2);
    expect(engine.status).toBe('synced');
    await engine.stop();
  });

  it('stops for good with a persistent notice when the device is revoked', async () => {
    const { engine, events, calls, tick } = await setup([new ApiError(ErrorCode.DEVICE_REVOKED, 'this device has been revoked', 401)]);
    await engine.start();
    await tick(0);
    await tick(3_600_000);
    expect(calls).toHaveLength(1);
    expect(events).toContainEqual({ type: 'notice', code: 'DEVICE_REVOKED', message: 'this device has been revoked', persistent: true });
    expect(engine.status).toBe('error');
  });

  it('shows a persistent notice for QUOTA_EXCEEDED and keeps retrying', async () => {
    const { engine, events, calls, tick } = await setup([new ApiError(ErrorCode.QUOTA_EXCEEDED, 'storage quota exceeded', 507), empty, empty]);
    await engine.start();
    await tick(0);
    expect(events).toContainEqual(expect.objectContaining({ type: 'notice', code: 'QUOTA_EXCEEDED', persistent: true }));
    expect(engine.status).toBe('error');
    await tick(1000);
    expect(calls).toHaveLength(2);
    await engine.stop();
  });

  it('reconciles every 15 minutes', async () => {
    const { engine, calls, tick } = await setup([]);
    await engine.start();
    await tick(0);
    await tick(15 * 60_000);
    expect(calls).toHaveLength(2);
    await engine.stop();
  });
});

describe('engine errors outside the plan table', () => {
  it('backs off after an unexpected bug-class error (TypeError) instead of stopping or skipping a file', async () => {
    const { engine, events, calls, tick } = await setup([new TypeError('x is undefined'), empty, empty]);
    await engine.start();
    await tick(0);
    expect(engine.status).toBe('error');
    expect(events.some((e) => e.type === 'notice')).toBe(false);
    await tick(499);
    expect(calls).toHaveLength(1); // attempt 0 waits 500..1000 ms
    await tick(501);
    expect(calls).toHaveLength(2);
    expect(engine.status).toBe('synced');
    await engine.stop();
  });

  it('refreshes the keyring at once when a version uses an epoch this device has no key for', async () => {
    const clock = new ManualClock(0);
    const r = seededRandom(2);
    const vaultId = '0123456789abcdef0123456789abcdef';
    const namingKey = r.bytes(32);
    const k1 = r.bytes(32);
    const k2 = r.bytes(32);
    const ring1 = await buildKeyring(vaultId, namingKey, new Map([[1, k1]]), 1);
    const ring2 = await buildKeyring(vaultId, namingKey, new Map([[1, k1], [2, k2]]), 2);
    // A deletion committed by another device under the new epoch 2.
    const fileId = await fileIdFor(namingKey, 'gone.md');
    const versionId = r.bytes(16);
    const encMeta = await encryptMeta(r, vaultId, epochKeys(ring2, 2), fileId, versionId, {
      path: 'gone.md', mtimeMs: 1, size: 0, contentHash: new Uint8Array(0), renamedFrom: '', deviceName: 'other',
    });
    const version: RemoteVersion = {
      fileId, versionId, baseVersionId: new Uint8Array(0), epoch: 2, encMeta, chunkIds: [], size: 0, deleted: true,
      deviceId: 'dev', createdAtMs: 1, seq: 1,
    };
    let changesCalls = 0;
    const api = {
      token: undefined,
      baseUrl: 'http://localhost',
      changes: async (_v: string, since: number): Promise<ChangesPage> => {
        changesCalls++;
        return since === 0 ? { versions: [version], vaultSeq: 1, more: false } : { versions: [], vaultSeq: 1, more: false };
      },
      heads: async (): Promise<HeadsPage> => ({ heads: [{ fileId, versionId, seq: 1, deleted: true }], more: false }),
    } as unknown as ApiClient;
    const state = await LocalState.open(new IDBFactory(), 'engine-epoch');
    let refreshes = 0;
    const events: EngineEvent[] = [];
    const engine = new SyncEngine({
      api, state, adapter: new MemoryAdapter(false, clock), ring: ring1, deviceName: 'd', clock, random: r, webSocket: null,
      backoff: { baseMs: 1000, maxMs: 60_000 },
      refreshKeyring: async () => {
        refreshes++;
        return ring2;
      },
    });
    engine.on((e) => events.push(e));
    await engine.start();
    clock.advance(0);
    await engine.whenIdle();
    expect(refreshes).toBe(1);
    clock.advance(0); // the retry is scheduled at once, without backoff
    await engine.whenIdle();
    expect(refreshes).toBe(1);
    expect(engine.status).toBe('synced');
    expect(await state.getFile(toHex(fileId))).toMatchObject({ versionId: toHex(versionId), deleted: true });
    expect(await state.allFailures()).toEqual([]);
    expect(changesCalls).toBe(2);
    await engine.stop();
  });

  it('fails only the file whose epoch key a keyring refresh did not provide', async () => {
    const clock = new ManualClock(0);
    const r = seededRandom(5);
    const vaultId = '0123456789abcdef0123456789abcdef';
    const namingKey = r.bytes(32);
    const k1 = r.bytes(32);
    const ring1 = await buildKeyring(vaultId, namingKey, new Map([[1, k1]]), 1);
    const ring2 = await buildKeyring(vaultId, namingKey, new Map([[1, k1], [2, r.bytes(32)]]), 2);
    const deletion = async (ring: typeof ring1, epoch: number, path: string, seq: number): Promise<RemoteVersion> => {
      const fileId = await fileIdFor(namingKey, path);
      const versionId = r.bytes(16);
      const encMeta = await encryptMeta(r, vaultId, epochKeys(ring, epoch), fileId, versionId, {
        path, mtimeMs: 1, size: 0, contentHash: new Uint8Array(0), renamedFrom: '', deviceName: 'other',
      });
      return { fileId, versionId, baseVersionId: new Uint8Array(0), epoch, encMeta, chunkIds: [], size: 0, deleted: true, deviceId: 'dev', createdAtMs: 1, seq };
    };
    const unreadable = await deletion(ring2, 2, 'unreadable.md', 1);
    const fine = await deletion(ring1, 1, 'fine.md', 2);
    const api = {
      token: undefined,
      baseUrl: 'http://localhost',
      changes: async (_v: string, since: number): Promise<ChangesPage> =>
        since === 0 ? { versions: [unreadable, fine], vaultSeq: 2, more: false } : { versions: [], vaultSeq: 2, more: false },
      heads: async (): Promise<HeadsPage> => ({
        heads: [unreadable, fine].map((v) => ({ fileId: v.fileId, versionId: v.versionId, seq: v.seq, deleted: true })), more: false,
      }),
      history: async (_v: string, fileId: Uint8Array): Promise<RemoteVersion[]> => [unreadable, fine].filter((v) => toHex(v.fileId) === toHex(fileId)),
    } as unknown as ApiClient;
    const state = await LocalState.open(new IDBFactory(), 'engine-epoch-missing');
    let refreshes = 0;
    const events: EngineEvent[] = [];
    const engine = new SyncEngine({
      api, state, adapter: new MemoryAdapter(false, clock), ring: ring1, deviceName: 'd', clock, random: r, webSocket: null,
      backoff: { baseMs: 1000, maxMs: 60_000 },
      refreshKeyring: async () => {
        refreshes++;
        return ring1; // the server has no epoch 2 key for this account
      },
    });
    engine.on((e) => events.push(e));
    await engine.start();
    clock.advance(0);
    await engine.whenIdle();
    expect(refreshes).toBe(1);
    clock.advance(1000);
    await engine.whenIdle();
    expect(engine.status).toBe('synced');
    expect(await state.getFile(toHex(fine.fileId))).toMatchObject({ versionId: toHex(fine.versionId), deleted: true });
    expect(await state.getFile(toHex(unreadable.fileId))).toBeUndefined();
    expect((await state.allFailures()).map((f) => f.key)).toEqual([`apply:${toHex(unreadable.fileId)}`]);
    expect(events).toContainEqual(expect.objectContaining({ type: 'notice', code: 'DECRYPT_FAILED' }));
    expect(await state.getCursor()).toBe(2);
    // The file's retry (after its 1 min backoff) fails on its own again,
    // without another refresh or a failed cycle.
    clock.advance(60_000);
    await engine.whenIdle();
    expect(refreshes).toBe(1);
    expect(engine.status).toBe('synced');
    expect((await state.allFailures())[0]?.attempts).toBe(2);
    await engine.stop();
  });

  it('backs off when the keyring cannot be refreshed', async () => {
    const r = seededRandom(4);
    const ring = await buildKeyring('0123456789abcdef0123456789abcdef', r.bytes(32), new Map([[1, r.bytes(32)]]), 1);
    const clock = new ManualClock(0);
    let calls = 0;
    const api = {
      token: undefined,
      baseUrl: 'http://localhost',
      changes: async (): Promise<ChangesPage> => {
        calls++;
        throw new MissingEpochKeyError(2);
      },
      heads: async (): Promise<HeadsPage> => ({ heads: [], more: false }),
    } as unknown as ApiClient;
    const engine = new SyncEngine({
      api, state: await LocalState.open(new IDBFactory(), 'engine-epoch-2'), adapter: new MemoryAdapter(false, clock), ring,
      deviceName: 'd', clock, random: r, webSocket: null, backoff: { baseMs: 1000, maxMs: 60_000 },
      refreshKeyring: async () => ring, // still without epoch 2
    });
    await engine.start();
    clock.advance(0);
    await engine.whenIdle();
    expect(engine.status).toBe('error');
    expect(calls).toBe(1);
    clock.advance(1000);
    await engine.whenIdle();
    expect(calls).toBe(2);
    await engine.stop();
  });
});

/** An engine on a scripted API whose vault seq the test sets; counts /changes and /heads calls. */
async function scripted(o: { api?: Record<string, unknown>; engine?: Partial<ConstructorParameters<typeof SyncEngine>[0]> } = {}) {
  const clock = new ManualClock(0);
  const server = { vaultSeq: 0, changes: 0, heads: 0, headsError: null as Error | null };
  const api = {
    token: undefined,
    baseUrl: 'http://localhost',
    changes: async (): Promise<ChangesPage> => {
      server.changes++;
      return { versions: [], vaultSeq: server.vaultSeq, more: false };
    },
    heads: async (): Promise<HeadsPage> => {
      server.heads++;
      if (server.headsError) throw server.headsError;
      return { heads: [], more: false };
    },
    ...o.api,
  } as unknown as ApiClient;
  const r = seededRandom(9);
  const ring = await buildKeyring('0123456789abcdef0123456789abcdef', r.bytes(32), new Map([[1, r.bytes(32)]]), 1);
  const state = await LocalState.open(new IDBFactory(), `scripted-${Math.random()}`);
  const adapter = new MemoryAdapter(false, clock);
  const events: EngineEvent[] = [];
  const engine = new SyncEngine({
    api, state, adapter, ring, deviceName: 'd', clock, random: r, webSocket: null, backoff: { baseMs: 1000, maxMs: 60_000 }, ...o.engine,
  });
  engine.on((e) => events.push(e));
  /** Runs every cycle due now (a zero-delay loop would never settle; bounded to tell). */
  const settle = async () => {
    for (let i = 0; i < 30; i++) {
      clock.advance(0);
      await engine.whenIdle();
    }
  };
  const tick = async (ms: number) => {
    clock.advance(ms);
    await engine.whenIdle();
  };
  return { engine, server, clock, state, adapter, events, settle, tick };
}

describe('engine scheduling', () => {
  it('does not spin while a dirty file waits out its per-file failure', async () => {
    const { engine, server, adapter, state, settle, tick } = await scripted();
    await adapter.write('broken.md', new TextEncoder().encode('x'));
    adapter.failReads('broken.md');
    await state.markDirty('broken.md');
    await engine.start();
    await settle();
    expect(server.changes).toBe(1);
    const failure = (await state.allFailures())[0]!;
    await tick(failure.nextAt); // the retry
    await settle();
    expect(server.changes).toBe(2);
    await engine.stop();
  });

  it('does not spin after a server rollback lowered the vault seq', async () => {
    const { engine, server, events, settle } = await scripted();
    server.vaultSeq = 10;
    await engine.start();
    await settle();
    engine.requestSync(); // a plain pull, which learns the vault seq
    await settle();
    expect(engine.status).toBe('synced');
    server.vaultSeq = 5; // restored from a backup
    const before = server.changes;
    engine.requestSync();
    await settle();
    expect(events).toContainEqual(expect.objectContaining({ type: 'notice', code: 'SERVER_ROLLBACK' }));
    expect(server.changes - before).toBeLessThanOrEqual(3); // the failed pull, the reconcile's pull, one more at most
    expect(engine.status).toBe('synced');
    await engine.stop();
  });

  it('reconciles again after a reconcile that failed', async () => {
    const { engine, server, settle, tick } = await scripted();
    server.headsError = new NetworkError('down');
    await engine.start();
    await settle();
    expect(server.heads).toBe(1);
    expect(engine.status).toBe('offline');
    server.headsError = null;
    await tick(1000); // the backoff
    expect(server.heads).toBe(2);
    expect(engine.status).toBe('synced');
    await engine.stop();
  });

  it('retries a failed remote version when its backoff ends, not on the next unrelated cycle', async () => {
    const fileId = new Uint8Array(32).fill(7);
    const bad: RemoteVersion = {
      fileId, versionId: new Uint8Array(16).fill(8), baseVersionId: new Uint8Array(0), epoch: 1, encMeta: new Uint8Array(80),
      chunkIds: [], size: 0, deleted: true, deviceId: 'dev', createdAtMs: 1, seq: 1,
    };
    let heads = 0;
    const committed: Array<{ fileId: Uint8Array; versionId: Uint8Array; seq: number; deleted: boolean }> = [];
    const { engine, state, adapter, settle, tick } = await scripted({
      api: {
        changes: async (_v: string, since: number): Promise<ChangesPage> => ({ versions: since === 0 ? [bad] : [], vaultSeq: 1, more: false }),
        heads: async (): Promise<HeadsPage> => {
          heads++;
          return { heads: [{ fileId, versionId: bad.versionId, seq: 1, deleted: true }, ...committed], more: false };
        },
        history: async (): Promise<RemoteVersion[]> => [bad],
        chunksExist: async (_v: string, ids: Uint8Array[]) => ids.map(() => true),
        commit: async (_v: string, commits: Array<{ fileId: Uint8Array; versionId: Uint8Array }>) => {
          for (const c of commits) committed.push({ fileId: c.fileId, versionId: c.versionId, seq: 2 + committed.length, deleted: false });
          return { results: commits.map((c) => ({ fileId: c.fileId, ok: true, seq: committed.find((h) => h.fileId === c.fileId)!.seq, headVersionId: new Uint8Array(0) })), vaultSeq: 1 + committed.length };
        },
      },
    });
    await engine.start();
    await settle();
    expect(heads).toBe(1);
    const failure = (await state.allFailures())[0]!;
    expect(failure.key).toBe(`apply:${toHex(fileId)}`);
    await adapter.write('note.md', new TextEncoder().encode('x')); // an unrelated local change starts a cycle
    await tick(1000);
    expect(engine.status).toBe('synced');
    expect(heads).toBe(1);
    await tick(failure.nextAt - 1000);
    await settle();
    expect(heads).toBe(2);
    await engine.stop();
  });
});
