import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { ManualClock } from '../../src/util/clock';
import { CONFLICT_COPY_PATTERN } from '../../src/util/path';
import { makeClient, settle, type SimClient } from '../helpers/client';
import { files, nameKeepingCollision, newUser, text } from '../helpers/fixture';
import { startServer, type TestServer } from '../helpers/server';

let srv: TestServer;
beforeAll(async () => {
  srv = await startServer(inject('obsyncBin'));
});
afterAll(() => srv?.stop());

/** Two devices of a fresh user on one vault. */
async function pair(opts: { caseInsensitiveA?: boolean; caseInsensitiveB?: boolean } = {}): Promise<[SimClient, SimClient]> {
  const user = await newUser(srv);
  const a = await makeClient(srv, user, { name: 'Laptop', vault: 'create', caseInsensitive: opts.caseInsensitiveA ?? false });
  const b = await makeClient(srv, user, { name: 'Phone', vault: a.vaultId, caseInsensitive: opts.caseInsensitiveB ?? false });
  return [a, b];
}

describe('sync engine against the real server', () => {
  it('propagates creates, edits and deletes', async () => {
    const [a, b] = await pair();
    await a.adapter.write('Notes/hello.md', text('# Hello\n'));
    await settle([a, b]);
    expect(files(b.adapter)).toEqual({ 'Notes/hello.md': '# Hello\n' });
    await b.adapter.write('Notes/hello.md', text('# Hello\nfrom phone\n'));
    await settle([a, b]);
    expect(files(a.adapter)['Notes/hello.md']).toBe('# Hello\nfrom phone\n');
    await a.adapter.remove('Notes/hello.md');
    await settle([a, b]);
    expect(files(b.adapter)).toEqual({});
  });

  it('retries a commit whose response was lost without a conflict copy', async () => {
    const [a, b] = await pair();
    await a.adapter.write('note.md', text('one\n'));
    a.net.loseNextResponse('POST', '/commit');
    await a.engine.runCycle(); // the commit lands, its response is lost
    expect(await a.state.allPending()).toHaveLength(1);
    await settle([a, b]);
    expect(files(a.adapter)).toEqual({ 'note.md': 'one\n' });
    expect(files(b.adapter)).toEqual({ 'note.md': 'one\n' });
    expect(a.events.some((e) => e.type === 'conflict')).toBe(false);
  });

  it('recognises its own landed commit coming back and keeps a newer local edit without a conflict copy', async () => {
    const [a, b] = await pair();
    await a.adapter.write('note.md', text('one\n'));
    await settle([a, b]);
    await a.adapter.write('note.md', text('two\n'));
    a.net.loseNextResponse('POST', '/commit');
    await a.engine.runCycle(); // "two" lands; a never hears back
    await a.adapter.write('note.md', text('three\n'));
    await settle([a, b]); // the next pull returns a's own "two"
    expect(files(a.adapter)).toEqual({ 'note.md': 'three\n' });
    expect(files(b.adapter)).toEqual({ 'note.md': 'three\n' });
    expect(a.events.some((e) => e.type === 'conflict')).toBe(false);
  });

  it('drops a pending commit that a newer remote version overtook instead of resending it', async () => {
    const [a, b] = await pair();
    await a.adapter.write('n.md', text('from laptop\n'));
    await b.adapter.write('n.md', text('from phone\n'));
    b.net.loseNextResponse('POST', '/commit');
    await b.engine.runCycle(); // b's create lands; b never hears back
    await a.engine.runCycle(); // a conflicts with it, keeps its text, commits on top
    await settle([a, b]);
    expect(files(b.adapter)).toEqual(files(a.adapter));
    expect(files(a.adapter)['n.md']).toBe('from laptop\n');
    expect(Object.keys(files(a.adapter))).toHaveLength(2); // n.md and a's one conflict copy
    const head = (await a.api.changes(a.vaultId, 0)).versions.at(-1)!;
    const recs = await b.state.filesByPath('n.md');
    expect(recs[0]?.versionId).toBe(Buffer.from(head.versionId).toString('hex'));
  });

  it('merges concurrent edits to different parts of a note', async () => {
    const [a, b] = await pair();
    await a.adapter.write('n.md', text('title\n\nalpha\nbeta\ngamma\ndelta\n'));
    await settle([a, b]);
    await a.adapter.write('n.md', text('TITLE\n\nalpha\nbeta\ngamma\ndelta\n'));
    await b.adapter.write('n.md', text('title\n\nalpha\nbeta\ngamma\nDELTA\n'));
    await settle([a, b]);
    expect(files(a.adapter)).toEqual({ 'n.md': 'TITLE\n\nalpha\nbeta\ngamma\nDELTA\n' });
    expect(files(b.adapter)).toEqual(files(a.adapter));
  });

  it('keeps both sides of overlapping edits, one as a conflict copy', async () => {
    const [a, b] = await pair();
    await a.adapter.write('n.md', text('line\n'));
    await settle([a, b]);
    await a.adapter.write('n.md', text('from laptop\n'));
    await b.adapter.write('n.md', text('from phone\n'));
    await a.engine.runCycle();
    await b.engine.runCycle(); // b's push conflicts; b keeps its text and saves a's as a copy
    await settle([a, b]);
    const onA = files(a.adapter);
    expect(onA['n.md']).toBe('from phone\n');
    const copies = Object.keys(onA).filter((p) => CONFLICT_COPY_PATTERN.test(p));
    expect(copies).toEqual(['n (conflict Laptop 2026-01-02 0304).md']);
    expect(onA[copies[0]!]).toBe('from laptop\n');
    expect(files(b.adapter)).toEqual(onA);
    expect(b.events).toContainEqual({ type: 'conflict', path: 'n.md', conflictPath: copies[0] });
  });

  it('lets a local edit win over a remote delete', async () => {
    const [a, b] = await pair();
    await a.adapter.write('n.md', text('v1\n'));
    await settle([a, b]);
    await a.adapter.remove('n.md');
    await b.adapter.write('n.md', text('v2\n'));
    await a.engine.runCycle(); // the tombstone lands first
    await settle([a, b]);
    expect(files(a.adapter)).toEqual({ 'n.md': 'v2\n' });
    expect(files(b.adapter)).toEqual({ 'n.md': 'v2\n' });
  });

  it('lets a remote edit win over a local delete', async () => {
    const [a, b] = await pair();
    await a.adapter.write('n.md', text('v1\n'));
    await settle([a, b]);
    await b.adapter.write('n.md', text('v2\n'));
    await a.adapter.remove('n.md');
    await b.engine.runCycle(); // the edit lands first
    await settle([a, b]);
    expect(files(a.adapter)).toEqual({ 'n.md': 'v2\n' });
    expect(files(b.adapter)).toEqual({ 'n.md': 'v2\n' });
  });

  it('re-creates a deleted path on top of its tombstone', async () => {
    const [a, b] = await pair();
    await a.adapter.write('n.md', text('first\n'));
    await settle([a, b]);
    await a.adapter.remove('n.md');
    await settle([a, b]);
    await b.adapter.write('n.md', text('second\n'));
    await settle([a, b]);
    expect(files(a.adapter)).toEqual({ 'n.md': 'second\n' });
    expect(b.events.some((e) => e.type === 'conflict')).toBe(false);
  });

  it('renames without uploading the content again', async () => {
    const [a, b] = await pair();
    await a.adapter.write('old.md', text('content that should not be uploaded twice\n'));
    await settle([a, b]);
    const puts = a.net.count('PUT', '/chunks/');
    await a.adapter.rename('old.md', 'Archive/new.md');
    await settle([a, b]);
    expect(a.net.count('PUT', '/chunks/')).toBe(puts);
    expect(files(b.adapter)).toEqual({ 'Archive/new.md': 'content that should not be uploaded twice\n' });
  });

  it('keeps offline edits across a restart and pushes them later', async () => {
    const [a, b] = await pair();
    a.net.setOnline(false);
    await a.adapter.write('offline.md', text('written offline\n'));
    await a.engine.runCycle();
    expect(a.engine.status).toBe('offline');
    await a.restart();
    a.net.setOnline(true);
    await settle([a, b]);
    expect(files(b.adapter)).toEqual({ 'offline.md': 'written offline\n' });
  });

  it('writes a conflict copy for concurrent binary edits', async () => {
    const [a, b] = await pair();
    await a.adapter.write('img.png', new Uint8Array([1, 2, 3]));
    await settle([a, b]);
    await a.adapter.write('img.png', new Uint8Array([4, 5, 6]));
    await b.adapter.write('img.png', new Uint8Array([7, 8, 9]));
    await a.engine.runCycle();
    await settle([a, b]);
    const snap = a.adapter.snapshot();
    expect([...snap.keys()].sort()).toEqual(['img (conflict Laptop 2026-01-02 0304).png', 'img.png']);
    expect([...snap.get('img.png')!]).toEqual([7, 8, 9]);
  });

  it('saves a file that differs only in case as a conflict copy on a case-insensitive device', async () => {
    const [a, b] = await pair({ caseInsensitiveB: true });
    await b.adapter.write('readme.md', text('lower\n'));
    await a.adapter.write('README.md', text('upper\n'));
    await b.engine.runCycle();
    await settle([a, b]);
    // The name with the lower file id keeps the path; the other file is saved beside it.
    expect(files(b.adapter)).toEqual(
      (await nameKeepingCollision(b, 'readme.md', 'README.md')) === 'readme.md'
        ? { 'readme.md': 'lower\n', 'README (conflict Laptop 2026-01-02 0304).md': 'upper\n' }
        : { 'README.md': 'upper\n', 'readme (conflict Phone 2026-01-02 0304).md': 'lower\n' },
    );
    expect(b.events.some((e) => e.type === 'notice' && e.code === 'CASE_COLLISION')).toBe(true);
  });

  it('renames a file to another case on case-insensitive devices without a conflict copy', async () => {
    const [a, b] = await pair({ caseInsensitiveA: true, caseInsensitiveB: true });
    await a.adapter.write('todo.md', text('- milk\n'));
    await settle([a, b]);
    await a.adapter.rename('todo.md', 'TODO.md');
    await settle([a, b]);
    expect(files(a.adapter)).toEqual({ 'TODO.md': '- milk\n' });
    expect(files(b.adapter)).toEqual({ 'TODO.md': '- milk\n' });
    expect(b.events.some((e) => e.type === 'notice' && e.code === 'CASE_COLLISION')).toBe(false);
  });

  it('keeps syncing other files while one cannot be read, and retries it later', async () => {
    const [a, b] = await pair();
    await a.adapter.write('broken.md', text('x\n'));
    await a.adapter.write('fine.md', text('y\n'));
    a.adapter.failReads('broken.md');
    await a.engine.runCycle();
    await settle([b]);
    expect(files(b.adapter)).toEqual({ 'fine.md': 'y\n' });
    expect(a.events).toContainEqual(expect.objectContaining({ type: 'notice', code: 'FILE_FAILED', path: 'broken.md' }));
    expect(a.engine.status).toBe('synced');
    a.adapter.failReads('broken.md', false);
    (a.clock as ManualClock).advance(2 * 60_000); // past the first backoff (1 min, with jitter)
    await a.engine.runCycle();
    await settle([a, b]);
    expect(files(b.adapter)).toEqual({ 'broken.md': 'x\n', 'fine.md': 'y\n' });
  });

  it('stops syncing with a persistent notice when the device is revoked', async () => {
    const [a, b] = await pair();
    await b.api.revokeDevice(a.session.deviceId);
    await a.adapter.write('n.md', text('x\n'));
    await a.engine.runCycle();
    await a.engine.whenIdle();
    expect(a.events).toContainEqual(expect.objectContaining({ type: 'notice', code: 'DEVICE_REVOKED', persistent: true }));
    expect(['stopped', 'error']).toContain(a.engine.status);
  });
});
