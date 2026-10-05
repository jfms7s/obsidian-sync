import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import type { ApiClient } from '../../src/api/client';
import { ErrorCode } from '../../src/api/errors';
import type { CommitInput, CommitReply } from '../../src/api/types';
import { buildKeyring } from '../../src/crypto/vaultkeys';
import { LocalState } from '../../src/state/store';
import { DEFAULT_MAX_FILE_BYTES, type SyncContext } from '../../src/sync/context';
import type { EngineEvent } from '../../src/sync/events';
import { batchCommits, PushMemory, pushRound } from '../../src/sync/push';
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
