import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { LocalState, type FileRecord, type PendingCommit } from '../../src/state/store';

async function open(factory = new IDBFactory(), name = 'test') {
  return LocalState.open(factory, name);
}

const rec = (over: Partial<FileRecord> = {}): FileRecord => ({
  fileId: 'aa', path: 'a.md', versionId: '01', deleted: false, contentHash: 'h', size: 1, localMtime: 5, hasBase: false, seq: 7, ...over,
});

describe('LocalState', () => {
  it('stores session, keys, vault, cursor and settings', async () => {
    const st = await open();
    expect(await st.getCursor()).toBe(0);
    await st.setCursor(42);
    await st.setSession({ serverUrl: 'https://s', username: 'u', userId: 'x', deviceId: 'd', deviceName: 'n', token: 't' });
    await st.setUserKeys({ userId: 'u1', encPriv: new Uint8Array([1]), signSeed: new Uint8Array([2]) });
    await st.setSetting('ignoreGlobs', ['*.pdf']);
    expect(await st.getCursor()).toBe(42);
    expect((await st.getSession())?.token).toBe('t');
    expect((await st.getUserKeys())?.signSeed).toEqual(new Uint8Array([2]));
    expect(await st.getSetting('ignoreGlobs', [])).toEqual(['*.pdf']);
    await st.clearSession();
    expect(await st.getSession()).toBeUndefined();
  });

  it('records a synced file with its base and clears the pending commit atomically', async () => {
    const st = await open();
    const p: PendingCommit = {
      fileId: 'aa', path: 'a.md', versionId: '02', baseVersionId: '01', epoch: 1, encMeta: new Uint8Array([9]),
      chunkIds: [new Uint8Array(32)], size: 1, deleted: false, contentHash: 'h2', mtime: 6, text: 'x',
    };
    await st.putPending(p);
    await st.recordSynced(rec({ versionId: '02' }), 'base text', true);
    expect(await st.getPending('aa')).toBeUndefined();
    expect((await st.getFile('aa'))?.hasBase).toBe(true);
    expect(await st.getBase('aa')).toBe('base text');
    expect(await st.filesByPath('a.md')).toHaveLength(1);
    await st.recordSynced(rec({ versionId: '03', deleted: true, contentHash: null }), null);
    expect(await st.getBase('aa')).toBeUndefined();
  });

  it('clears a dirty path only if it was not marked again', async () => {
    const st = await open();
    const g1 = await st.markDirty('a.md');
    const g2 = await st.markDirty('a.md');
    expect(await st.clearDirty('a.md', g1)).toBe(false);
    expect(await st.clearDirty('a.md', g2)).toBe(true);
    expect(await st.dirtyEntries()).toEqual([]);
  });

  it('keeps a rename hint until the path is cleared', async () => {
    const st = await open();
    await st.markDirty('new.md', 'old.md');
    await st.markDirty('new.md');
    expect(await st.dirtyEntries()).toEqual([expect.objectContaining({ path: 'new.md', renamedFrom: 'old.md' })]);
  });

  it('survives reopening, continuing dirty generations', async () => {
    const factory = new IDBFactory();
    const st = await open(factory, 'persist');
    const g = await st.markDirty('a.md');
    st.close();
    const again = await open(factory, 'persist');
    expect(await again.dirtyEntries()).toEqual([{ path: 'a.md', gen: g }]);
    expect(await again.markDirty('b.md')).toBeGreaterThan(g);
  });

  it('forgets synced versions after a server rollback but keeps paths', async () => {
    const st = await open();
    await st.recordSynced(rec(), 'base');
    await st.setCursor(10);
    await st.setCursorAnchor({ seq: 10, versionId: 'ab' });
    await st.forgetSyncedVersions();
    expect(await st.getFile('aa')).toEqual(rec({ versionId: null, contentHash: null, localMtime: -1, hasBase: false, seq: 0 }));
    expect(await st.getBase('aa')).toBeUndefined();
    expect(await st.getCursor()).toBe(0);
    expect(await st.getCursorAnchor()).toBeNull();
  });

  it('keeps refusals and failures per path', async () => {
    const st = await open();
    await st.putRefusal({ path: 'big.bin', fingerprint: 'stat:9:1', message: 'too large' });
    await st.putFailure({ key: 'push:a.md', attempts: 2, nextAt: 99, message: 'EIO' });
    expect((await st.getRefusal('big.bin'))?.fingerprint).toBe('stat:9:1');
    expect(await st.allFailures()).toEqual([{ key: 'push:a.md', attempts: 2, nextAt: 99, message: 'EIO' }]);
    await st.deleteRefusal('big.bin');
    await st.deleteFailure('push:a.md');
    expect(await st.getRefusal('big.bin')).toBeUndefined();
    expect(await st.getFailure('push:a.md')).toBeUndefined();
  });

  it('resets all vault state', async () => {
    const st = await open();
    await st.recordSynced(rec(), 'b');
    await st.markDirty('x.md');
    await st.setVault({ vaultId: 'v', name: 'n', namingKey: new Uint8Array(32), epochKeys: [], currentEpoch: 1 });
    await st.resetVaultState();
    expect(await st.allFiles()).toEqual([]);
    expect(await st.dirtyEntries()).toEqual([]);
    expect(await st.getVault()).toBeUndefined();
  });
});
