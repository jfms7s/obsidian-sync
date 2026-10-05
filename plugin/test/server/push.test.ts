// Push (spec §5.3) against the real server.
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { decryptMeta } from '../../src/crypto/objects';
import { pull } from '../../src/sync/pull';
import { MAX_FILES_PER_ROUND, PushMemory, pushRound } from '../../src/sync/push';
import { files, newDevice, newUser, text, trackChanges, type Device } from '../helpers/fixture';
import { startServer, type TestServer } from '../helpers/server';

let srv: TestServer;
beforeAll(async () => {
  srv = await startServer(inject('obsyncBin'), { env: { OBSYNC_MAX_FILE_SIZE_BYTES: '100000' } });
});
afterAll(() => srv?.stop());

async function pair(o: { maxFileBytes?: number } = {}): Promise<[Device, Device, () => Promise<void>, () => Promise<void>]> {
  const user = await newUser(srv);
  const a = await newDevice(srv, user, { name: 'A', vault: 'create', ...o });
  const b = await newDevice(srv, user, { name: 'B', vault: a.vaultId });
  return [a, b, trackChanges(a), trackChanges(b)];
}

async function push(d: Device, flush: () => Promise<void>, mem = new PushMemory()) {
  await flush();
  return pushRound(d.ctx, mem);
}

async function serverMeta(d: Device) {
  const page = await d.api.changes(d.vaultId, 0);
  return Promise.all(page.versions.map(async (v) => ({ v, meta: await decryptMeta(d.ring, v.epoch, v.fileId, v.versionId, v.encMeta) })));
}

describe('push', () => {
  it('commits creates, edits and deletes with the right bases', async () => {
    const [a, b, fa] = await pair();
    await a.adapter.write('n.md', text('one\n'));
    expect(await push(a, fa)).toMatchObject({ committed: 1, conflicts: 0 });
    await a.adapter.write('n.md', text('two\n'));
    await push(a, fa);
    await a.adapter.remove('n.md');
    await push(a, fa);
    const log = await serverMeta(a);
    expect(log.map((x) => [x.meta.path, x.v.deleted, x.meta.size])).toEqual([['n.md', false, 4], ['n.md', false, 4], ['n.md', true, 0]]);
    expect(log[1]!.v.baseVersionId).toEqual(log[0]!.v.versionId);
    expect(log[2]!.v.chunkIds).toEqual([]);
    expect(log.every((x) => x.meta.deviceName === 'A')).toBe(true);
    expect(await a.state.dirtyEntries()).toEqual([]);
    await pull(b.ctx);
    expect(files(b.adapter)).toEqual({});
  });

  it('pushes a rename as a delete, then a create that reuses chunks and names the old path', async () => {
    const [a, , fa] = await pair();
    await a.adapter.write('old.md', text('content\n'));
    await push(a, fa);
    const puts = a.net.count('PUT', '/chunks/');
    await a.adapter.rename('old.md', 'Folder/new.md');
    expect(await push(a, fa)).toMatchObject({ committed: 2 });
    expect(a.net.count('PUT', '/chunks/')).toBe(puts);
    const log = await serverMeta(a);
    expect(log.slice(1).map((x) => [x.meta.path, x.v.deleted, x.meta.renamedFrom])).toEqual([['old.md', true, ''], ['Folder/new.md', false, 'old.md']]);
  });

  it('resends the same version after a lost response and gets its original seq', async () => {
    const [a, , fa] = await pair();
    await a.adapter.write('n.md', text('one\n'));
    a.net.loseNextResponse('POST', '/commit');
    await expect(push(a, fa)).rejects.toThrow();
    const pending = await a.state.allPending();
    expect(pending).toHaveLength(1);
    expect(await push(a, fa)).toMatchObject({ committed: 1, conflicts: 0 });
    expect((await a.state.filesByPath('n.md'))[0]?.versionId).toBe(pending[0]!.versionId);
    expect((await a.api.changes(a.vaultId, 0)).vaultSeq).toBe(1);
  });

  it('resolves a conflict by pulling the head, then pushes the merge on top', async () => {
    const [a, b, fa, fb] = await pair();
    await a.adapter.write('n.md', text('1\n2\n3\n4\n'));
    await push(a, fa);
    await pull(b.ctx);
    await a.adapter.write('n.md', text('one\n2\n3\n4\n'));
    await push(a, fa);
    await b.adapter.write('n.md', text('1\n2\n3\nfour\n'));
    expect(await push(b, fb)).toMatchObject({ committed: 0, conflicts: 1 });
    expect(files(b.adapter)).toEqual({ 'n.md': 'one\n2\n3\nfour\n' });
    expect(await push(b, fb)).toMatchObject({ committed: 1 });
    await pull(a.ctx);
    expect(files(a.adapter)).toEqual({ 'n.md': 'one\n2\n3\nfour\n' });
  });

  it('commits the delete half of a rename no later than its create, even across rounds', async () => {
    const [a, , fa] = await pair();
    await a.adapter.write('b.md', text('moved\n'));
    await push(a, fa);
    // Enough new files that sort between the two halves to fill a whole round.
    for (let i = 0; i < MAX_FILES_PER_ROUND - 1; i++) await a.adapter.write(`a${String(i).padStart(3, '0')}.md`, text(`${i}\n`));
    await a.adapter.rename('b.md', 'a.md');
    while ((await push(a, fa)).worked);
    const log = await serverMeta(a);
    const seqOf = (path: string, deleted: boolean) => log.find((x) => x.meta.path === path && x.v.deleted === deleted)!.v.seq;
    expect(seqOf('b.md', true)).toBeLessThan(seqOf('a.md', false));
  });

  it('re-creates a deleted file on top of its tombstone', async () => {
    const [a, b, fa, fb] = await pair();
    await a.adapter.write('n.md', text('one\n'));
    await push(a, fa);
    await a.adapter.remove('n.md');
    await push(a, fa);
    await pull(b.ctx);
    await b.adapter.write('n.md', text('again\n'));
    expect(await push(b, fb)).toMatchObject({ committed: 1, conflicts: 0 });
  });

  it('reports a file over the server limit once and does not retry it, even after a restart', async () => {
    const [a, , fa] = await pair();
    await a.adapter.write('big.bin', new Uint8Array(100_001));
    expect(await push(a, fa)).toMatchObject({ committed: 0 });
    expect(a.events).toContainEqual(expect.objectContaining({ type: 'notice', code: 'TOO_LARGE', path: 'big.bin', persistent: true }));
    await a.state.markDirty('big.bin');
    const commits = a.net.count('POST', '/commit');
    expect(await push(a, fa, new PushMemory())).toMatchObject({ worked: true, committed: 0 }); // fresh memory: the refusal is in IndexedDB
    expect(a.net.count('POST', '/commit')).toBe(commits);
    expect(a.events.filter((e) => e.type === 'notice')).toHaveLength(1);
    await a.adapter.write('big.bin', new Uint8Array(10)); // changed: tried again
    expect(await push(a, fa)).toMatchObject({ committed: 1 });
  });

  it('keeps a newer local edit queued when a resent pending commit is refused', async () => {
    const [a, , fa] = await pair();
    await a.adapter.write('big.bin', new Uint8Array(100_001));
    a.net.loseNextResponse('POST', '/commit'); // refused, but the device never hears it
    await expect(push(a, fa)).rejects.toThrow();
    await a.adapter.write('big.bin', new Uint8Array(10)); // edited meanwhile
    expect(await push(a, fa)).toMatchObject({ committed: 0 }); // the resend is refused again
    expect(await push(a, fa)).toMatchObject({ committed: 1 }); // the edit is still queued
    const heads = (await a.api.heads(a.vaultId, null)).heads;
    expect(heads).toHaveLength(1);
  });

  it('does not read or upload a file over the device limit', async () => {
    const [a, , fa] = await pair({ maxFileBytes: 1000 });
    await a.adapter.write('video.mp4', new Uint8Array(1001));
    a.adapter.failReads('video.mp4'); // proves it is never read
    expect(await push(a, fa)).toMatchObject({ committed: 0 });
    expect(a.net.count('PUT', '/chunks/')).toBe(0);
    expect(a.events).toContainEqual(expect.objectContaining({ type: 'notice', code: 'TOO_LARGE', path: 'video.mp4', persistent: true }));
    expect(await a.state.getRefusal('video.mp4')).toMatchObject({ fingerprint: expect.stringMatching(/^stat:1001:/) });
  });

  it('drops a resent pending commit without reading the file when the file changed size', async () => {
    const [a, , fa] = await pair({ maxFileBytes: 10 });
    await a.adapter.write('n.md', text('hi\n'));
    a.net.setOnline(false); // the pending commit is stored, its chunk never uploaded
    await expect(push(a, fa)).rejects.toThrow();
    expect(await a.state.allPending()).toHaveLength(1);
    await a.adapter.write('n.md', new Uint8Array(20)); // now over the device limit
    a.adapter.failReads('n.md'); // proves it is never read
    a.net.setOnline(true);
    await push(a, fa);
    expect(await a.state.allPending()).toEqual([]);
    await push(a, fa);
    expect(a.events.filter((e) => e.type === 'notice').map((e) => (e as { code: string }).code)).toEqual(['TOO_LARGE']);
    expect(a.net.count('PUT', '/chunks/')).toBe(0);
  });

  it('skips ignored and invalid paths', async () => {
    const [a, , fa] = await pair();
    await a.adapter.write('.obsidian/app.json', text('{}'));
    await a.adapter.write('.DS_Store', text('x'));
    expect(await push(a, fa)).toMatchObject({ committed: 0 });
    expect(await a.state.dirtyEntries()).toEqual([]);
  });
});
