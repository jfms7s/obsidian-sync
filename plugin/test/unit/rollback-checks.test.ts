// The checks that reveal a server restored from a backup, without a server:
// a synced version newer than the server's seq, and a vault too big for
// spreading its heads into Math.max (RangeError above ~125,000 arguments,
// fewer on iOS).
import { IDBFactory } from 'fake-indexeddb';
import { expect, it } from 'vitest';
import type { ApiClient } from '../../src/api/client';
import type { ChangesPage, HeadsPage, RemoteHead, RemoteVersion } from '../../src/api/types';
import { buildKeyring } from '../../src/crypto/vaultkeys';
import { LocalState } from '../../src/state/store';
import { DEFAULT_MAX_FILE_BYTES, ServerRollbackError, type SyncContext } from '../../src/sync/context';
import { pull } from '../../src/sync/pull';
import { reconcile } from '../../src/sync/reconcile';
import { ManualClock } from '../../src/util/clock';
import { seededRandom } from '../../src/util/random';
import { IgnoreRules } from '../../src/vault/ignore';
import { MemoryAdapter } from '../../src/vault/memory';

async function context(name: string, api: Partial<ApiClient>): Promise<SyncContext> {
  const state = await LocalState.open(new IDBFactory(), name);
  await state.recordSynced({ fileId: 'aa', path: 'a.md', versionId: '01', deleted: false, contentHash: 'h', size: 1, localMtime: 1, hasBase: false, seq: 9 }, 'a');
  const r = seededRandom(3);
  return {
    api: api as ApiClient, state, adapter: new MemoryAdapter(), deviceName: 'd', clock: new ManualClock(), random: r,
    ring: await buildKeyring('0123456789abcdef0123456789abcdef', r.bytes(32), new Map([[1, r.bytes(32)]]), 1),
    ignore: new IgnoreRules(), maxFileBytes: DEFAULT_MAX_FILE_BYTES, emit: () => undefined,
  };
}

it('detects a rollback from a synced version newer than the server\'s seq, even with the cursor behind it', async () => {
  // A crash after applying a page but before saving the cursor leaves the
  // cursor behind its records; a restored server then has a seq below them.
  const ctx = await context('ahead', { changes: async (): Promise<ChangesPage> => ({ versions: [], vaultSeq: 4, more: false }) });
  expect(await ctx.state.getCursor()).toBe(0);
  await expect(pull(ctx)).rejects.toBeInstanceOf(ServerRollbackError);
});

it('detects a rollback from a version at the seq of a different synced version', async () => {
  const other: RemoteVersion = {
    fileId: new Uint8Array([7]), versionId: new Uint8Array([8]), baseVersionId: new Uint8Array(0), epoch: 1, encMeta: new Uint8Array(0),
    chunkIds: [], size: 0, deleted: false, deviceId: 'd', createdAtMs: 1, seq: 9,
  };
  // The record says version 01 of file aa sits at seq 9; the server has a different version there.
  const ctx = await context('reused', { changes: async (): Promise<ChangesPage> => ({ versions: [other], vaultSeq: 9, more: false }) });
  await expect(pull(ctx)).rejects.toBeInstanceOf(ServerRollbackError);
});

it('does not call a server rolled back when its seq is at or above every synced version', async () => {
  const ctx = await context('level', { changes: async (): Promise<ChangesPage> => ({ versions: [], vaultSeq: 9, more: false }) });
  await expect(pull(ctx)).resolves.toMatchObject({ vaultSeq: 9 });
});

it('reports a rolled-back server for a vault of 150,000 files without a RangeError', async () => {
  const heads: RemoteHead[] = Array.from({ length: 150_000 }, (_, i) => ({
    fileId: new Uint8Array([1, i >> 16, (i >> 8) & 255, i & 255]), versionId: new Uint8Array([2]), seq: 1 + (i % 9), deleted: false,
  }));
  const ctx = await context('big', {
    changes: async (): Promise<ChangesPage> => ({ versions: [], vaultSeq: 10, more: false }),
    // Pages like the server does: in file id order, `limit` at a time.
    heads: async (_vault: string, after: Uint8Array | null, limit?: number): Promise<HeadsPage> => {
      const start = after ? ((after[1]! << 16) | (after[2]! << 8) | after[3]!) + 1 : 0;
      const page = heads.slice(start, start + (limit ?? 5000));
      return { heads: page, more: start + page.length < heads.length };
    },
  });
  await expect(reconcile(ctx)).rejects.toBeInstanceOf(ServerRollbackError);
});
