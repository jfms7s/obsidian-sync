// A trash restore brings back the version the deletion removed. If that one
// cannot be read, it fails; it never quietly restores an older version.
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import type { ApiClient } from '../../src/api/client';
import type { RemoteVersion } from '../../src/api/types';
import { encryptMeta, fileIdFor } from '../../src/crypto/objects';
import { buildKeyring, epochKeys } from '../../src/crypto/vaultkeys';
import { NotInTrashError, PathOccupiedError, restore, UnsyncedChangesError, type HistoryEntry } from '../../src/services/history';
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
  await expect(restore(api, ring, adapter, state, entry)).rejects.toThrow(/the deletion removed/);
  expect(await adapter.list()).toEqual([]);
});

describe('restore', () => {
  const vaultId = '0123456789abcdef0123456789abcdef';

  /** A readable live version of path with one chunk, and an API that counts chunk downloads. */
  async function setup(path: string, name: string, caseInsensitive = false) {
    const r = seededRandom(6);
    const ring = await buildKeyring(vaultId, r.bytes(32), new Map([[1, r.bytes(32)]]), 1);
    const fileId = await fileIdFor(ring.namingKey, path);
    const versionId = r.bytes(16);
    const meta = { path, mtimeMs: 1, size: 3, contentHash: new Uint8Array(32), renamedFrom: '', deviceName: 'd' };
    const version: RemoteVersion = {
      fileId, versionId, baseVersionId: new Uint8Array(0), epoch: 1, chunkIds: [r.bytes(32)], size: 3, deleted: false, deviceId: 'd', createdAtMs: 1, seq: 1,
      encMeta: await encryptMeta(r, vaultId, epochKeys(ring, 1), fileId, versionId, meta),
    };
    let downloads = 0;
    const api = {
      getChunk: async () => {
        downloads++;
        throw new Error('the test serves no chunks');
      },
      history: async () => [version],
    } as unknown as ApiClient;
    const entry: HistoryEntry = { version, versionId: 'bb', meta };
    return { ring, api, entry, adapter: new MemoryAdapter(caseInsensitive), state: await LocalState.open(new IDBFactory(), name), downloads: () => downloads };
  }

  it('refuses before downloading anything when the path is taken or changed here', async () => {
    const t = await setup('a/b/n.md', 'refuse-early');
    await t.adapter.write('a/b/n.md', new TextEncoder().encode('local, never synced\n'));
    await expect(restore(t.api, t.ring, t.adapter, t.state, t.entry)).rejects.toBeInstanceOf(UnsyncedChangesError);
    await t.adapter.remove('a/b/n.md');
    await t.adapter.write('a/b/n.md/inside.md', new TextEncoder().encode('a folder\n'));
    await expect(restore(t.api, t.ring, t.adapter, t.state, t.entry)).rejects.toBeInstanceOf(PathOccupiedError);
    expect(t.downloads()).toBe(0);
  });

  it('refuses when a file holds a deeper ancestor folder, also in another letter case', async () => {
    const deep = await setup('x/y/z/n.md', 'deep-ancestor');
    await deep.adapter.write('x/y', new TextEncoder().encode('a file\n'));
    await expect(restore(deep.api, deep.ring, deep.adapter, deep.state, deep.entry)).rejects.toMatchObject({ name: 'PathOccupiedError', occupiedBy: 'x/y' });
    const ci = await setup('notes/sub/n.md', 'ci-ancestor', true);
    await ci.adapter.write('Notes', new TextEncoder().encode('a file\n'));
    await expect(restore(ci.api, ci.ring, ci.adapter, ci.state, ci.entry)).rejects.toMatchObject({ name: 'PathOccupiedError', occupiedBy: 'Notes' });
    expect(deep.downloads() + ci.downloads()).toBe(0);
  });

  it('names the file that exists again as well as it can', async () => {
    const t = await setup('n.md', 'not-in-trash');
    const live = { ...t.entry.version };
    const tomb: RemoteVersion = { ...t.entry.version, deleted: true, seq: 0 };
    const api = (first: HistoryEntry['version']) => ({ history: async () => [first] }) as unknown as ApiClient;
    const unreadable = { ...live, encMeta: new Uint8Array(80) };
    await expect(restore(api(live), t.ring, t.adapter, t.state, { version: tomb, versionId: 'cc', meta: null }))
      .rejects.toEqual(new NotInTrashError('n.md')); // from the live version's metadata
    await expect(restore(api(unreadable), t.ring, t.adapter, t.state, { version: tomb, versionId: 'cc', meta: { ...t.entry.meta!, path: 'from-entry.md' } }))
      .rejects.toEqual(new NotInTrashError('from-entry.md'));
    await expect(restore(api(unreadable), t.ring, t.adapter, t.state, { version: tomb, versionId: 'cc', meta: null }))
      .rejects.toEqual(new NotInTrashError('the file'));
  });
});
