import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { openDb } from '../../src/state/idb';
import { DB_VERSION, LocalState, upgradeSchema, type FileRecord, type PendingCommit } from '../../src/state/store';

function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${what}: timed out`)), ms))]);
}

function rawOpen(factory: IDBFactory, name: string, version: number, upgrade?: (db: IDBDatabase, old: number, tx: IDBTransaction) => void): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = factory.open(name, version);
    r.onupgradeneeded = (ev) => upgrade?.(r.result, ev.oldVersion, r.transaction!);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

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
    await st.setVault({ userId: 'u', vaultId: 'v', name: 'n', namingKey: new Uint8Array(32), epochKeys: [], currentEpoch: 1 });
    await st.resetVaultState();
    expect(await st.allFiles()).toEqual([]);
    expect(await st.dirtyEntries()).toEqual([]);
    expect(await st.getVault()).toBeUndefined();
  });

  it('keeps dirty generations unique across two instances on one database', async () => {
    const factory = new IDBFactory();
    const a = await open(factory, 'shared');
    const b = await open(factory, 'shared');
    const ga = await a.markDirty('x.md');
    const gb = await b.markDirty('x.md'); // a newer mark through the other instance
    expect(gb).not.toBe(ga);
    expect(await a.clearDirty('x.md', ga)).toBe(false); // must not drop b's newer mark
    expect(await a.dirtyEntries()).toEqual([{ path: 'x.md', gen: gb }]);
  });

  it('sets the cursor and its anchor in one step', async () => {
    const st = await open();
    await st.setCursorAndAnchor(12, { seq: 12, versionId: 'cd' });
    expect(await st.getCursor()).toBe(12);
    expect(await st.getCursorAnchor()).toEqual({ seq: 12, versionId: 'cd' });
    await st.setCursorAndAnchor(13, null);
    expect(await st.getCursor()).toBe(13);
    expect(await st.getCursorAnchor()).toBeNull();
  });

  it('clears only the pending commit of the version it records', async () => {
    const st = await open();
    const p: PendingCommit = {
      fileId: 'aa', path: 'a.md', versionId: '05', baseVersionId: '01', epoch: 1, encMeta: new Uint8Array([9]),
      chunkIds: [], size: 1, deleted: false, contentHash: 'h5', mtime: 6, text: 'x',
    };
    await st.putPending(p);
    await st.recordSynced(rec({ versionId: '04' }), 'other', true); // another device's version
    expect(await st.getPending('aa')).toEqual(p);
    await st.recordSynced(rec({ versionId: '05' }), 'x', true);
    expect(await st.getPending('aa')).toBeUndefined();
  });

  it('drops a push failure when its dirty mark clears or its path is renamed away', async () => {
    const st = await open();
    await st.putFailure({ key: 'push:a.md', attempts: 1, nextAt: 99, message: 'EIO' });
    await st.putFailure({ key: 'push:old.md', attempts: 1, nextAt: 99, message: 'EIO' });
    const g = await st.markDirty('a.md');
    expect(await st.getFailure('push:a.md')).toBeDefined(); // still backing off while dirty
    await st.clearDirty('a.md', g);
    expect(await st.getFailure('push:a.md')).toBeUndefined();
    await st.markDirty('new.md', 'old.md');
    expect(await st.getFailure('push:old.md')).toBeUndefined();
  });

  it('upgrades only from the versions it knows, so a newer schema step does not recreate stores', async () => {
    const factory = new IDBFactory();
    (await open(factory, 'up')).close();
    const db = await rawOpen(factory, 'up', DB_VERSION + 1, (d, old, tx) => upgradeSchema(d, old, tx));
    expect([...db.objectStoreNames]).toContain('dirty');
    db.close();
  });

  it('closes its connection when another tab or a newer version wants the database', async () => {
    const factory = new IDBFactory();
    await open(factory, 'vc');
    const newer = await within(rawOpen(factory, 'vc', DB_VERSION + 1), 1000, 'open a newer version');
    newer.close();
  });

  it('closes a connection that succeeds only after its open was reported blocked', async () => {
    const factory = new IDBFactory();
    const holder = await rawOpen(factory, 'blk', 1);
    await expect(openDb(factory, 'blk', 2, () => undefined)).rejects.toThrow(/open elsewhere/);
    holder.close(); // the blocked open now goes through
    await new Promise((r) => setTimeout(r, 50));
    const later = await within(rawOpen(factory, 'blk', 3), 1000, 'open version 3');
    later.close();
  });

  it('knows the highest seq among its records, also in a database created before the seq index existed', async () => {
    const factory = new IDBFactory();
    const old = await rawOpen(factory, 'v1', 1, (d) => {
      d.createObjectStore('files', { keyPath: 'fileId' }).createIndex('path', 'path', { unique: false });
    });
    old.close();
    const st = await open(factory, 'v1'); // upgrades 1 → 2
    expect(await st.maxFileSeq()).toBe(0);
    await st.putFile(rec({ fileId: 'a1', seq: 7 }));
    await st.putFile(rec({ fileId: 'a2', path: 'b.md', seq: 12 }));
    await st.putFile(rec({ fileId: 'a3', path: 'c.md', seq: 3 }));
    expect(await st.maxFileSeq()).toBe(12);
    expect((await st.filesAtSeq(7)).map((r) => r.fileId)).toEqual(['a1']);
    expect(await st.filesAtSeq(8)).toEqual([]);
    st.close();
  });
});
