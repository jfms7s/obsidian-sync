// Pull and the apply table of spec §5.5, against the real server.
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { fileIdFor } from '../../src/crypto/objects';
import { fromHex, toHex } from '../../src/util/bytes';
import { ServerRollbackError } from '../../src/sync/context';
import { newestPerFile, pull, resolveConflict } from '../../src/sync/pull';
import { PushMemory, pushRound } from '../../src/sync/push';
import type { RemoteVersion } from '../../src/api/types';
import { files, landedPendingOvertakenTwice, newDevice, newUser, remoteCommit, text, type Device } from '../helpers/fixture';
import { startServer, type TestServer } from '../helpers/server';

let srv: TestServer;
beforeAll(async () => {
  srv = await startServer(inject('obsyncBin'));
});
afterAll(() => srv?.stop());

async function device(o: { caseInsensitive?: boolean; ignoreGlobs?: string[]; maxFileBytes?: number } = {}): Promise<Device> {
  return newDevice(srv, await newUser(srv), { name: 'Here', vault: 'create', ...o });
}

/** a.md is at y with the other device's edits, without a conflict, and pushing does not revert them. */
async function expectAdoptedThenAdvanced(a: Device, y: string): Promise<void> {
  expect(a.events.filter((e) => e.type === 'conflict')).toEqual([]);
  expect(files(a.adapter)).toEqual({ 'a.md': 'base\nmine\ntheirs\nmore\n' });
  expect(await a.state.allPending()).toEqual([]);
  expect((await a.state.filesByPath('a.md'))[0]?.versionId).toBe(y);
  await pushRound(a.ctx, new PushMemory());
  const heads = (await a.api.heads(a.vaultId, null)).heads;
  expect(heads.map((h) => toHex(h.versionId))).toEqual([y]);
}

const dirtyPaths = async (d: Device) => (await d.state.dirtyEntries()).map((e) => e.path).sort();

describe('pull', () => {
  it('writes new remote files, overwrites unchanged ones and deletes', async () => {
    const d = await device();
    await remoteCommit(d, 'a.md', text('one\n'));
    await pull(d.ctx);
    expect(files(d.adapter)).toEqual({ 'a.md': 'one\n' });
    await remoteCommit(d, 'a.md', text('two\n'));
    await pull(d.ctx);
    expect(files(d.adapter)).toEqual({ 'a.md': 'two\n' });
    await remoteCommit(d, 'a.md', null);
    await pull(d.ctx);
    expect(files(d.adapter)).toEqual({});
    expect(await dirtyPaths(d)).toEqual([]);
    expect(await d.state.getCursor()).toBe(3);
  });

  it('keeps a local edit over a remote delete and queues it', async () => {
    const d = await device();
    await remoteCommit(d, 'a.md', text('one\n'));
    await pull(d.ctx);
    await d.adapter.write('a.md', text('edited\n'));
    const tomb = await remoteCommit(d, 'a.md', null);
    await pull(d.ctx);
    expect(files(d.adapter)).toEqual({ 'a.md': 'edited\n' });
    expect((await d.state.filesByPath('a.md'))[0]).toMatchObject({ versionId: toHex(tomb), deleted: true });
    expect(await dirtyPaths(d)).toEqual(['a.md']);
  });

  it('restores a locally deleted file when the remote edited it', async () => {
    const d = await device();
    await remoteCommit(d, 'a.md', text('one\n'));
    await pull(d.ctx);
    await d.adapter.remove('a.md');
    await remoteCommit(d, 'a.md', text('remote edit\n'));
    await pull(d.ctx);
    expect(files(d.adapter)).toEqual({ 'a.md': 'remote edit\n' });
  });

  it('merges a clean text change and queues the merge result', async () => {
    const d = await device();
    await remoteCommit(d, 'a.md', text('1\n2\n3\n4\n5\n'));
    await pull(d.ctx);
    await d.adapter.write('a.md', text('one\n2\n3\n4\n5\n'));
    await remoteCommit(d, 'a.md', text('1\n2\n3\n4\nfive\n'));
    await pull(d.ctx);
    expect(files(d.adapter)).toEqual({ 'a.md': 'one\n2\n3\n4\nfive\n' });
    expect(d.events).toContainEqual({ type: 'merged', path: 'a.md' });
    expect(await dirtyPaths(d)).toEqual(['a.md']);
  });

  it('writes a conflict copy named after the remote device for overlapping edits', async () => {
    const d = await device();
    await remoteCommit(d, 'Notes/a.md', text('base\n'));
    await pull(d.ctx);
    await d.adapter.write('Notes/a.md', text('mine\n'));
    await remoteCommit(d, 'Notes/a.md', text('theirs\n'), 'Work PC');
    await pull(d.ctx);
    expect(files(d.adapter)).toEqual({ 'Notes/a.md': 'mine\n', 'Notes/a (conflict Work PC 2026-01-02 0304).md': 'theirs\n' });
    expect(await dirtyPaths(d)).toEqual(['Notes/a (conflict Work PC 2026-01-02 0304).md', 'Notes/a.md']);
  });

  it('adopts a remote version identical to an independently created local file', async () => {
    const d = await device();
    await d.adapter.write('a.md', text('same\n'));
    await remoteCommit(d, 'a.md', text('same\n'));
    await pull(d.ctx);
    expect(d.events.filter((e) => e.type === 'conflict')).toEqual([]);
    expect((await d.state.filesByPath('a.md'))[0]?.contentHash).not.toBeNull();
  });

  it('saves a remote file that differs only in case as a conflict copy, once', async () => {
    const d = await device({ caseInsensitive: true });
    await d.adapter.write('readme.md', text('local\n'));
    await remoteCommit(d, 'README.md', text('remote\n'), 'Mac');
    await pull(d.ctx);
    expect(files(d.adapter)).toEqual({ 'readme.md': 'local\n', 'README (conflict Mac 2026-01-02 0304).md': 'remote\n' });
    expect((await d.state.filesByPath('README.md'))[0]).toMatchObject({ shadowed: true });
    await remoteCommit(d, 'README.md', text('remote 2\n'), 'Mac');
    await pull(d.ctx);
    expect(Object.keys(files(d.adapter))).toHaveLength(2);
  });

  it('records but does not write ignored paths', async () => {
    const d = await device({ ignoreGlobs: ['Private/'] });
    await remoteCommit(d, 'Private/x.md', text('secret\n'));
    await pull(d.ctx);
    expect(files(d.adapter)).toEqual({});
    expect((await d.state.filesByPath('Private/x.md'))[0]).toMatchObject({ ignored: true });
  });

  it('skips a version whose metadata does not decrypt, with a notice', async () => {
    const d = await device();
    const r = d.random;
    await d.api.commit(d.vaultId, [{ fileId: r.bytes(32), versionId: r.bytes(16), baseVersionId: new Uint8Array(0), epoch: 1, encMeta: r.bytes(60), chunkIds: [], size: 0, deleted: false }]);
    await pull(d.ctx);
    expect(d.events).toContainEqual(expect.objectContaining({ type: 'notice', code: 'DECRYPT_FAILED' }));
    expect(await d.state.getCursor()).toBe(1);
  });

  it('skips a version that contradicts its own metadata', async () => {
    const d = await device();
    await remoteCommit(d, 'liar.md', text('four\n'), 'Remote', { size: 999 }); // the version says 5 bytes
    await remoteCommit(d, 'ok.md', text('fine\n'));
    await pull(d.ctx);
    expect(files(d.adapter)).toEqual({ 'ok.md': 'fine\n' });
    expect(d.events).toContainEqual(expect.objectContaining({ type: 'notice', code: 'DECRYPT_FAILED', path: 'liar.md' }));
    expect(await d.state.getCursor()).toBe(2);
  });

  it('skips a version whose chunks the server lost, and keeps pulling', async () => {
    const d = await device();
    await remoteCommit(d, 'lost.md', text('gone\n'));
    rmSync(join(srv.dataDir, 'blobs', d.vaultId), { recursive: true, force: true });
    await remoteCommit(d, 'ok.md', text('fine\n'));
    await pull(d.ctx);
    expect(files(d.adapter)).toEqual({ 'ok.md': 'fine\n' });
    expect(d.events).toContainEqual(expect.objectContaining({ type: 'notice', code: 'CONTENT_MISSING', path: 'lost.md' }));
    expect(await d.state.getCursor()).toBe(2);
  });

  it('records one failing file for a later retry and applies the rest', async () => {
    const d = await device();
    await d.adapter.write('stuck.md', text('local\n'));
    d.adapter.failReads('stuck.md');
    await remoteCommit(d, 'stuck.md', text('remote\n'));
    await remoteCommit(d, 'ok.md', text('fine\n'));
    await pull(d.ctx);
    expect(files(d.adapter)['ok.md']).toBe('fine\n');
    expect(await d.state.getCursor()).toBe(2);
    const [failure] = await d.state.allFailures();
    expect(failure).toMatchObject({ attempts: 1 });
    expect(failure!.nextAt).toBeGreaterThan(d.clock.now());
    expect(d.events).toContainEqual(expect.objectContaining({ type: 'notice', code: 'FILE_FAILED', path: 'stuck.md' }));
  });

  it('does not download versions over the device size limit', async () => {
    const d = await device({ maxFileBytes: 10 });
    await remoteCommit(d, 'big.bin', new Uint8Array(11));
    await pull(d.ctx);
    expect(files(d.adapter)).toEqual({});
    expect(d.net.count('GET', '/chunks/')).toBe(0);
    expect((await d.state.filesByPath('big.bin'))[0]).toMatchObject({ tooLarge: true });
    expect(d.events).toContainEqual(expect.objectContaining({ type: 'notice', code: 'TOO_LARGE', persistent: true, path: 'big.bin' }));
  });

  it('renames instead of copying when a case-only rename arrives before its delete', async () => {
    const d = await device({ caseInsensitive: true });
    await remoteCommit(d, 'todo.md', text('- milk\n'));
    await pull(d.ctx);
    await remoteCommit(d, 'TODO.md', text('- milk\n'), 'Remote', { renamedFrom: 'todo.md' });
    await pull(d.ctx);
    expect(files(d.adapter)).toEqual({ 'TODO.md': '- milk\n' });
    await remoteCommit(d, 'todo.md', null);
    await pull(d.ctx);
    expect(files(d.adapter)).toEqual({ 'TODO.md': '- milk\n' });
    expect(d.events.some((e) => e.type === 'notice' && e.code === 'CASE_COLLISION')).toBe(false);
  });

  it('records its own landed commit as synced when the pull returns it', async () => {
    const d = await device();
    await remoteCommit(d, 'a.md', text('one\n'));
    await pull(d.ctx);
    const pushed = await d.api.changes(d.vaultId, 0);
    // Simulate a pending commit whose response was lost: the server has it, the device does not know.
    const v = pushed.versions[0]!;
    await d.state.putPending({
      fileId: toHex(v.fileId), path: 'a.md', versionId: toHex(v.versionId), baseVersionId: '', epoch: 1, encMeta: v.encMeta,
      chunkIds: v.chunkIds, size: v.size, deleted: false, contentHash: (await d.state.filesByPath('a.md'))[0]!.contentHash, mtime: 1, text: 'one\n',
    });
    await d.state.putFile({ ...(await d.state.filesByPath('a.md'))[0]!, versionId: null, seq: 0 });
    await d.state.setCursor(0);
    await d.state.setCursorAnchor(null);
    await pull(d.ctx);
    expect(await d.state.allPending()).toEqual([]);
    expect((await d.state.filesByPath('a.md'))[0]).toMatchObject({ versionId: toHex(v.versionId), seq: v.seq });
    expect(d.events.some((e) => e.type === 'conflict')).toBe(false);
  });

  it('adopts its own landed commit before newer versions built on it in the same page', async () => {
    const { a, y } = await landedPendingOvertakenTwice(srv);
    await pull(a.ctx);
    await expectAdoptedThenAdvanced(a, y);
  });

  it('adopts its own landed commit from the history when resolving a conflict', async () => {
    const { a, y } = await landedPendingOvertakenTwice(srv);
    await resolveConflict(a.ctx, await fileIdFor(a.ring.namingKey, 'a.md'), fromHex(y));
    await expectAdoptedThenAdvanced(a, y);
  });

  it('does not re-apply versions older than the one its record holds', async () => {
    const d = await device();
    await remoteCommit(d, 'a.md', text('a\nb\nc\n'));
    await remoteCommit(d, 'a.md', null);
    const v3 = await remoteCommit(d, 'a.md', text('A\nb\nc\n'));
    // A conflict resolution applies the head before the change log is read.
    await resolveConflict(d.ctx, await fileIdFor(d.ring.namingKey, 'a.md'), v3);
    await d.adapter.write('a.md', text('A\nb\nC\n'));
    await pull(d.ctx, 1); // one version per page: v1 and v2 arrive on their own
    expect(files(d.adapter)).toEqual({ 'a.md': 'A\nb\nC\n' });
    expect((await d.state.filesByPath('a.md'))[0]).toMatchObject({ versionId: toHex(v3), seq: 3 });
    expect(d.events.filter((e) => e.type === 'conflict' || e.type === 'merged')).toEqual([]);
    // Forgetting synced versions (a server rollback) resets the seq, so everything applies again.
    await d.state.forgetSyncedVersions();
    expect((await d.state.filesByPath('a.md'))[0]).toMatchObject({ versionId: null, seq: 0 });
    await d.adapter.write('a.md', text('A\nb\nc\n'));
    await pull(d.ctx);
    expect((await d.state.filesByPath('a.md'))[0]).toMatchObject({ versionId: toHex(v3), seq: 3 });
    expect(files(d.adapter)).toEqual({ 'a.md': 'A\nb\nc\n' });
  });

  it('pages through the change log', async () => {
    const d = await device();
    for (const p of ['a.md', 'b.md', 'c.md', 'd.md', 'e.md']) await remoteCommit(d, p, text(p));
    expect((await pull(d.ctx, 2)).applied).toBe(5);
    expect(Object.keys(files(d.adapter))).toHaveLength(5);
  });

  it('detects a server that went back in time', async () => {
    const d = await device();
    await d.state.setCursor(50);
    await expect(pull(d.ctx)).rejects.toBeInstanceOf(ServerRollbackError);
  });

  it('checks the version at its cursor, and a lost one reveals a rollback the seq hides', async () => {
    const d = await device();
    await remoteCommit(d, 'a.md', text('one\n'));
    await pull(d.ctx);
    expect(await d.state.getCursorAnchor()).toMatchObject({ seq: 1 });
    // The record says a.md was synced at seq 5, beyond the server's head: history was lost.
    const rec = (await d.state.filesByPath('a.md'))[0]!;
    await d.state.putFile({ ...rec, seq: 5 });
    await d.state.setCursorAnchor({ seq: 1, versionId: '00'.repeat(16) });
    await expect(pull(d.ctx)).rejects.toBeInstanceOf(ServerRollbackError);
  });

  it('treats a pruned anchor as harmless when the heads agree', async () => {
    const d = await device();
    await remoteCommit(d, 'a.md', text('one\n'));
    await pull(d.ctx);
    await d.state.setCursorAnchor({ seq: 1, versionId: '00'.repeat(16) }); // as if the version had been pruned
    await pull(d.ctx);
    expect(await d.state.getCursorAnchor()).toBeNull();
    await remoteCommit(d, 'b.md', text('two\n'));
    await pull(d.ctx);
    expect(await d.state.getCursorAnchor()).toMatchObject({ seq: 2 });
  });

  it('applies the version at its cursor when it is not the anchor and the heads agree', async () => {
    const d = await device();
    await remoteCommit(d, 'a.md', text('one\n'));
    await pull(d.ctx);
    await remoteCommit(d, 'b.md', text('two\n'));
    // The cursor already points at seq 2, but at a version other than b.md's.
    await d.state.setCursorAndAnchor(2, { seq: 2, versionId: '00'.repeat(16) });
    await pull(d.ctx);
    expect(files(d.adapter)).toEqual({ 'a.md': 'one\n', 'b.md': 'two\n' });
    expect(await d.state.getCursor()).toBe(2);
  });
});

describe('newestPerFile', () => {
  it('keeps only the last version of each file, deletions first, then in seq order', () => {
    const v = (file: number, seq: number, deleted = false) => ({ fileId: new Uint8Array([file]), seq, deleted }) as unknown as RemoteVersion;
    expect(newestPerFile([v(1, 1), v(2, 2), v(1, 3), v(3, 4), v(4, 5, true)]).map((x) => x.seq)).toEqual([5, 2, 3, 4]);
  });
});
