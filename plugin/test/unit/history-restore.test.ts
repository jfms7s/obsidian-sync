// A trash restore brings back the version the deletion removed. If that one
// cannot be read, it fails; it never quietly restores an older version.
import { IDBFactory } from 'fake-indexeddb';
import { expect, it } from 'vitest';
import type { ApiClient } from '../../src/api/client';
import type { RemoteVersion } from '../../src/api/types';
import { encryptMeta, fileIdFor } from '../../src/crypto/objects';
import { buildKeyring, epochKeys } from '../../src/crypto/vaultkeys';
import { restore, type HistoryEntry } from '../../src/services/history';
import { LocalState } from '../../src/state/store';
import { seededRandom } from '../../src/util/random';
import { MemoryAdapter } from '../../src/vault/memory';

it('refuses to restore an older version when the one the deletion removed cannot be decrypted', async () => {
  const r = seededRandom(5);
  const vaultId = '0123456789abcdef0123456789abcdef';
  const ring = await buildKeyring(vaultId, r.bytes(32), new Map([[1, r.bytes(32)]]), 1);
  const keys = epochKeys(ring, 1);
  const fileId = await fileIdFor(ring.namingKey, 'n.md');
  const version = async (seq: number, deleted: boolean, readable: boolean): Promise<RemoteVersion> => {
    const versionId = r.bytes(16);
    const meta = { path: 'n.md', mtimeMs: 1, size: 0, contentHash: new Uint8Array(0), renamedFrom: '', deviceName: 'd' };
    return {
      fileId, versionId, baseVersionId: new Uint8Array(0), epoch: 1, chunkIds: [], size: 0, deleted, deviceId: 'd', createdAtMs: 1, seq,
      encMeta: readable ? await encryptMeta(r, vaultId, keys, fileId, versionId, meta) : r.bytes(80),
    };
  };
  const tombstone = await version(3, true, true);
  const history = [tombstone, await version(2, false, false), await version(1, false, true)]; // newest first
  const api = { history: async () => history } as unknown as ApiClient;
  const entry: HistoryEntry = { version: tombstone, versionId: 'aa', meta: null };
  const state = await LocalState.open(new IDBFactory(), 'hr');
  const adapter = new MemoryAdapter();
  await expect(restore(api, ring, adapter, state, entry)).rejects.toThrow(/cannot be decrypted/);
  expect(await adapter.list()).toEqual([]);
});
