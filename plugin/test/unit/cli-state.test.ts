// obsync-cli's state: LocalState over fake-indexeddb, saved as a JSON
// snapshot and loaded again on start (spec D3).
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PersistentState, SNAPSHOT_FILE, StateFileError } from '../../cli/state';
import { DB_VERSION, type PendingCommit } from '../../src/state/store';

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function stateDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'obsync-state-'));
  dirs.push(d);
  return join(d, 'cli'); // not there yet: open creates it
}

const pending: PendingCommit = {
  fileId: 'aa', path: 'a.md', versionId: '02', baseVersionId: '01', epoch: 3, encMeta: new Uint8Array([9, 8, 7]),
  chunkIds: [new Uint8Array(32).fill(1), new Uint8Array(32).fill(2)], size: 11, deleted: false, contentHash: 'h2', mtime: 6, text: 'hello world',
};

describe('PersistentState', () => {
  it('starts empty, then reloads everything LocalState holds, byte arrays included', async () => {
    const dir = await stateDir();
    const a = await PersistentState.open(dir);
    expect(await a.state.getSession()).toBeUndefined();
    await a.state.setSession({ serverUrl: 'https://s', username: 'u', userId: 'x', deviceId: 'd', deviceName: 'Desktop', token: 't' });
    await a.state.setUserKeys({ userId: 'x', encPriv: new Uint8Array([1, 2]), signSeed: new Uint8Array([3]) });
    await a.state.setVault({ userId: 'x', vaultId: 'v', name: 'Notes', namingKey: new Uint8Array(32).fill(5), epochKeys: [[1, new Uint8Array([6])], [3, new Uint8Array([7])]], currentEpoch: 3 });
    await a.state.setCursorAndAnchor(42, { seq: 42, versionId: 'ff' });
    await a.state.recordSynced({ fileId: 'aa', path: 'a.md', versionId: '01', deleted: false, contentHash: 'h', size: 1, localMtime: 5, hasBase: true, seq: 41 }, 'base text');
    await a.state.putPending(pending);
    await a.state.markDirty('b.md', 'old.md');
    await a.state.putFailure({ key: 'push:c.md', attempts: 2, nextAt: 99, message: 'no' });
    await a.state.putRefusal({ path: 'd.bin', fingerprint: 'stat:1:2', message: 'too large' });
    await a.state.setIgnoreGlobs(['Private/']);
    await a.save();
    await a.close();

    const b = await PersistentState.open(dir);
    expect(await b.state.getSession()).toMatchObject({ deviceName: 'Desktop', token: 't' });
    expect((await b.state.getUserKeys())!.encPriv).toEqual(new Uint8Array([1, 2]));
    const v = (await b.state.getVault())!;
    expect(v.namingKey).toBeInstanceOf(Uint8Array);
    expect(v.epochKeys).toEqual([[1, new Uint8Array([6])], [3, new Uint8Array([7])]]);
    expect(await b.state.getCursor()).toBe(42);
    expect(await b.state.getCursorAnchor()).toEqual({ seq: 42, versionId: 'ff' });
    expect(await b.state.filesByPath('a.md')).toHaveLength(1); // the path index came back
    expect(await b.state.maxFileSeq()).toBe(41); // and the seq index
    expect(await b.state.getBase('aa')).toBe('base text');
    expect(await b.state.getPending('aa')).toEqual(pending);
    expect(await b.state.dirtyEntries()).toEqual([{ path: 'b.md', gen: 1, renamedFrom: 'old.md' }]);
    expect(await b.state.markDirty('e.md')).toBe(2); // the generation counter carried on
    expect(await b.state.getFailure('push:c.md')).toMatchObject({ attempts: 2 });
    expect(await b.state.getRefusal('d.bin')).toMatchObject({ message: 'too large' });
    expect(await b.state.getIgnoreGlobs()).toEqual(['Private/']);
    await b.close();
  });

  it('keeps the directory and the file private, and leaves no temporary file', async () => {
    const dir = await stateDir();
    const s = await PersistentState.open(dir);
    await s.state.setSession({ serverUrl: 'https://s', username: 'u', userId: 'x', deviceId: 'd', deviceName: 'n', token: 'secret' });
    await s.save();
    await s.save();
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect((await stat(join(dir, SNAPSHOT_FILE))).mode & 0o777).toBe(0o600);
    expect(await readdir(dir)).toEqual([SNAPSHOT_FILE]);
    await s.close();
  });

  it('serializes saves, and a save holds every change made before it was asked for', async () => {
    const dir = await stateDir();
    const s = await PersistentState.open(dir);
    const saves: Array<Promise<number>> = [];
    for (let i = 1; i <= 5; i++) {
      await s.state.setCursor(i);
      saves.push(s.save());
    }
    const took = await Promise.all(saves);
    expect(took.every((ms) => ms >= 0)).toBe(true);
    await s.close();
    const again = await PersistentState.open(dir);
    expect(await again.state.getCursor()).toBe(5);
    await again.close();
  });

  it('saves only when something changed since the last save', async () => {
    const s = await PersistentState.open(await stateDir());
    expect(await s.saveIfChanged()).toBeNull(); // nothing yet
    await s.state.setCursor(3);
    expect(await s.saveIfChanged()).not.toBeNull();
    expect(await s.saveIfChanged()).toBeNull();
    // Reads change nothing.
    await s.state.getCursor();
    await s.state.allFiles();
    await s.state.dirtyEntries();
    await s.state.maxFileSeq();
    expect(await s.saveIfChanged()).toBeNull();
    await s.state.markDirty('a.md');
    expect(await s.saveIfChanged()).not.toBeNull();
    await s.close();
  });

  it('refuses a damaged snapshot or one from a newer format instead of starting over', async () => {
    const dir = await stateDir();
    await (await PersistentState.open(dir)).close();
    await writeFile(join(dir, SNAPSHOT_FILE), '{"format":1,"version":2,"stores":[');
    await expect(PersistentState.open(dir)).rejects.toThrow(StateFileError);
    await writeFile(join(dir, SNAPSHOT_FILE), JSON.stringify({ format: 2, version: 1, stores: [] }));
    await expect(PersistentState.open(dir)).rejects.toThrow(/format 1/);
  });

  it('refuses a snapshot of a newer database version, and migrates an older one', async () => {
    const dir = await stateDir();
    const s = await PersistentState.open(dir);
    await s.state.setCursor(7);
    await s.save();
    await s.close();
    const snap = JSON.parse(await readFile(join(dir, SNAPSHOT_FILE), 'utf8')) as { version: number; stores: Array<{ name: string; indexes: Array<{ name: string }> }> };
    expect(snap.version).toBe(DB_VERSION);
    await writeFile(join(dir, SNAPSHOT_FILE), JSON.stringify({ ...snap, version: DB_VERSION + 1 }));
    await expect(PersistentState.open(dir)).rejects.toThrow(StateFileError);
    // A version-1 database had no seq index on files: LocalState's own migration adds it.
    const v1 = { ...snap, version: 1, stores: snap.stores.map((st) => (st.name === 'files' ? { ...st, indexes: st.indexes.filter((i) => i.name !== 'seq') } : st)) };
    await writeFile(join(dir, SNAPSHOT_FILE), JSON.stringify(v1));
    const old = await PersistentState.open(dir);
    expect(await old.state.getCursor()).toBe(7);
    expect(await old.state.maxFileSeq()).toBe(0);
    await old.close();
  });

  it('does not depend on the factory of another state', async () => {
    // Two CLIs (two state directories) in one process stay apart.
    const a = await PersistentState.open(await stateDir());
    const b = await PersistentState.open(await stateDir());
    await a.state.setCursor(1);
    expect(await b.state.getCursor()).toBe(0);
    await a.close();
    await b.close();
  });
});
