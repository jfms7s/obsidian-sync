import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import type { ApiClient } from '../../src/api/client';
import { ErrorCode } from '../../src/api/errors';
import type { CommitInput, CommitReply } from '../../src/api/types';
import { fileIdFor } from '../../src/crypto/objects';
import { buildKeyring } from '../../src/crypto/vaultkeys';
import { LocalState } from '../../src/state/store';
import { DEFAULT_MAX_FILE_BYTES, type SyncContext } from '../../src/sync/context';
import type { EngineEvent } from '../../src/sync/events';
import { batchCommits, PushMemory, pushRound, UPLOAD_CONCURRENCY } from '../../src/sync/push';
import { toHex } from '../../src/util/bytes';
import { ManualClock } from '../../src/util/clock';
import { seededRandom } from '../../src/util/random';
import { IgnoreRules } from '../../src/vault/ignore';
import { MemoryAdapter } from '../../src/vault/memory';

function commit(metaBytes: number, chunks = 0): CommitInput {
  return {
    fileId: new Uint8Array(32), versionId: new Uint8Array(16), baseVersionId: new Uint8Array(16), epoch: 1,
    encMeta: new Uint8Array(metaBytes), chunkIds: Array.from({ length: chunks }, () => new Uint8Array(32)), size: 0, deleted: false,
  };
}

describe('batchCommits', () => {
  it('caps a batch at 500 commits', () => {
    const batches = batchCommits(Array.from({ length: 1201 }, () => commit(100)));
    expect(batches.map((b) => b.length)).toEqual([500, 500, 201]);
  });
  it('caps a batch by encoded bytes, under the 8 MiB body limit', () => {
    // 64 KiB metadata (the server maximum) plus 512 chunk ids ≈ 82 KiB each.
    const batches = batchCommits(Array.from({ length: 300 }, () => commit(64 << 10, 512)));
    expect(batches.length).toBeGreaterThan(1);
    for (const b of batches) expect(b.length * ((64 << 10) + 512 * 34)).toBeLessThan(8 << 20);
  });
  it('puts a single oversized commit in a batch of its own', () => {
    expect(batchCommits([commit(10), commit(8 << 20), commit(10)], 500, 1 << 20).map((b) => b.length)).toEqual([1, 1, 1]);
  });
});

describe('pushRound with an unexpected commit result', () => {
  it('keeps the pending commit and fails the cycle instead of refusing the file for good', async () => {
    const r = seededRandom(3);
    const ring = await buildKeyring('0123456789abcdef0123456789abcdef', r.bytes(32), new Map([[1, r.bytes(32)]]), 1);
    const state = await LocalState.open(new IDBFactory(), 'push-unexpected');
    const clock = new ManualClock();
    const adapter = new MemoryAdapter(false, clock);
    await adapter.write('n.md', new TextEncoder().encode('x\n'));
    await state.markDirty('n.md');
    const api = {
      chunksExist: async (_v: string, ids: Uint8Array[]) => ids.map(() => true),
      putChunk: async () => undefined,
      commit: async (_v: string, commits: CommitInput[]): Promise<CommitReply> => ({
        results: commits.map((c) => ({ fileId: c.fileId, ok: false, seq: 0, headVersionId: new Uint8Array(0) })),
        vaultSeq: 0,
      }),
    } as unknown as ApiClient;
    const events: EngineEvent[] = [];
    const ctx: SyncContext = {
      api, state, adapter, ring, deviceName: 'd', clock, random: r, ignore: new IgnoreRules(), maxFileBytes: DEFAULT_MAX_FILE_BYTES,
      emit: (e) => events.push(e),
    };
    await expect(pushRound(ctx, new PushMemory())).rejects.toMatchObject({ name: 'ApiError', code: ErrorCode.INTERNAL });
    expect(await state.allPending()).toHaveLength(1);
    expect(await state.getRefusal('n.md')).toBeUndefined();
    expect((await state.dirtyEntries()).map((e) => e.path)).toEqual(['n.md']);
    expect(events.filter((e) => e.type === 'notice')).toEqual([]);
  });
});

describe('pushRound with MISSING_CHUNK', () => {
  /**
   * A device with one dirty file and a scripted server whose commit answers
   * MISSING_CHUNK `missing` times, then ok. Each MISSING_CHUNK also drops
   * every chunk (as if garbage collection took them), so the next exists
   * check answers false and the chunk must be uploaded again.
   */
  async function setup(name: string, missing: number) {
    const r = seededRandom(7);
    const ring = await buildKeyring('0123456789abcdef0123456789abcdef', r.bytes(32), new Map([[1, r.bytes(32)]]), 1);
    const state = await LocalState.open(new IDBFactory(), name);
    const clock = new ManualClock();
    const adapter = new MemoryAdapter(false, clock);
    await adapter.write('n.md', new TextEncoder().encode('x\n'));
    await state.markDirty('n.md');
    const stored = new Set<string>();
    const server = { puts: 0, commits: [] as string[], missingLeft: missing };
    const api = {
      chunksExist: async (_v: string, ids: Uint8Array[]) => ids.map((id) => stored.has(toHex(id))),
      putChunk: async (_v: string, id: Uint8Array) => {
        server.puts++;
        stored.add(toHex(id));
      },
      commit: async (_v: string, commits: CommitInput[]): Promise<CommitReply> => ({
        results: commits.map((c) => {
          server.commits.push(toHex(c.versionId));
          if (server.missingLeft > 0) {
            server.missingLeft--;
            stored.clear();
            return { fileId: c.fileId, ok: false, seq: 0, headVersionId: new Uint8Array(0), error: { code: ErrorCode.MISSING_CHUNK, message: 'chunk missing' } };
          }
          return { fileId: c.fileId, ok: true, seq: server.commits.length, headVersionId: c.versionId };
        }),
        vaultSeq: server.commits.length,
      }),
    } as unknown as ApiClient;
    const ctx: SyncContext = {
      api, state, adapter, ring, deviceName: 'd', clock, random: r, ignore: new IgnoreRules(), maxFileBytes: DEFAULT_MAX_FILE_BYTES,
      emit: () => undefined,
    };
    const mem = new PushMemory();
    const fileId = toHex(await fileIdFor(ring.namingKey, 'n.md'));
    const dirty = async () => (await state.dirtyEntries()).map((e) => e.path);
    return { ctx, state, mem, server, fileId, dirty };
  }

  it('keeps the pending commit, uploads the chunk again and lands it on the next round', async () => {
    const { ctx, state, mem, server, fileId, dirty } = await setup('missing-once', 1);
    expect(await pushRound(ctx, mem)).toMatchObject({ committed: 0 });
    expect(server.puts).toBe(1);
    expect(mem.missingChunk.get(fileId)).toBe(1);
    const pending = await state.getPending(fileId);
    expect(pending?.versionId).toBe(server.commits[0]);
    expect(await dirty()).toEqual(['n.md']);

    expect(await pushRound(ctx, mem)).toMatchObject({ committed: 1 });
    expect(server.puts).toBe(2); // the exists check found it gone and uploaded it again
    expect(server.commits).toEqual([pending!.versionId, pending!.versionId]); // the same commit, resent
    expect(await state.getPending(fileId)).toBeUndefined();
    expect(mem.missingChunk.has(fileId)).toBe(false);
    // A resent commit may describe an older state of the file, so its entry
    // stays until the next round finds the file equal to what landed.
    expect(await pushRound(ctx, mem)).toMatchObject({ committed: 0 });
    expect(server.commits).toHaveLength(2);
    expect(await dirty()).toEqual([]);
  });

  it('drops the pending commit after three MISSING_CHUNK results, keeps the file dirty and then builds a fresh commit', async () => {
    const { ctx, state, mem, server, fileId, dirty } = await setup('missing-thrice', 3);
    for (let round = 1; round <= 2; round++) {
      await pushRound(ctx, mem);
      expect(mem.missingChunk.get(fileId)).toBe(round);
      expect(await state.getPending(fileId)).toBeDefined();
    }
    const first = server.commits[0];
    expect(server.commits).toEqual([first, first]);

    await pushRound(ctx, mem);
    expect(server.commits).toEqual([first, first, first]);
    expect(await state.getPending(fileId)).toBeUndefined();
    expect(mem.missingChunk.has(fileId)).toBe(false);
    expect(await dirty()).toEqual(['n.md']);

    expect(await pushRound(ctx, mem)).toMatchObject({ committed: 1 });
    expect(server.commits).toHaveLength(4);
    expect(server.commits[3]).not.toBe(first); // a new commit, not the dropped one
    expect(server.puts).toBe(4);
    expect(await dirty()).toEqual([]);
  });
});

describe('pushRound transfers', () => {
  async function device(name: string, o: { maxBytesPerRound?: number } = {}) {
    const r = seededRandom(11);
    const ring = await buildKeyring('0123456789abcdef0123456789abcdef', r.bytes(32), new Map([[1, r.bytes(32)]]), 1);
    const state = await LocalState.open(new IDBFactory(), name);
    const clock = new ManualClock();
    const adapter = new MemoryAdapter(false, clock);
    const server = { inFlight: 0, most: 0, batches: [] as number[] };
    let seq = 0;
    const api = {
      chunksExist: async (_v: string, ids: Uint8Array[]) => ids.map(() => false),
      putChunk: async () => {
        server.most = Math.max(server.most, ++server.inFlight);
        await new Promise((res) => setTimeout(res, 5));
        server.inFlight--;
      },
      commit: async (_v: string, commits: CommitInput[]): Promise<CommitReply> => {
        server.batches.push(commits.length);
        return { results: commits.map((c) => ({ fileId: c.fileId, ok: true, seq: ++seq, headVersionId: c.versionId })), vaultSeq: seq };
      },
    } as unknown as ApiClient;
    const ctx: SyncContext = {
      api, state, adapter, ring, deviceName: 'd', clock, random: r, ignore: new IgnoreRules(), maxFileBytes: DEFAULT_MAX_FILE_BYTES,
      emit: () => undefined, ...o,
    };
    const write = async (path: string, content: string) => {
      await adapter.write(path, new TextEncoder().encode(content));
      await state.markDirty(path);
    };
    return { ctx, server, write };
  }

  it('uploads a few chunks at a time', async () => {
    const { ctx, server, write } = await device('push-concurrency');
    for (let i = 0; i < 8; i++) await write(`n${i}.md`, `note ${i}\n`);
    expect(await pushRound(ctx, new PushMemory())).toMatchObject({ committed: 8 });
    expect(server.most).toBeGreaterThan(1);
    expect(server.most).toBeLessThanOrEqual(UPLOAD_CONCURRENCY);
  });

  it('stops a round at maxBytesPerRound', async () => {
    const { ctx, server, write } = await device('push-round-bytes', { maxBytesPerRound: 10 });
    for (const p of ['a.md', 'b.md', 'c.md']) await write(p, '1234567\n'); // 8 bytes each
    const mem = new PushMemory();
    await pushRound(ctx, mem);
    await pushRound(ctx, mem);
    expect(server.batches).toEqual([2, 1]);
  });
});
