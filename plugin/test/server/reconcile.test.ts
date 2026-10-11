// Reconcile (spec §5.6): catching what events missed.
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import type { FileRecord } from '../../src/state/store';
import { toHex } from '../../src/util/bytes';
import { pull } from '../../src/sync/pull';
import { PushMemory, pushRound } from '../../src/sync/push';
import { reconcile } from '../../src/sync/reconcile';
import { ManualClock } from '../../src/util/clock';
import { files, landedPendingOvertakenTwice, newDevice, newUser, remoteCommit, text } from '../helpers/fixture';
import { startServer, type TestServer } from '../helpers/server';

let srv: TestServer;
beforeAll(async () => {
  srv = await startServer(inject('obsyncBin'));
});
afterAll(() => srv?.stop());

it('queues files created, changed or deleted without events', async () => {
  const d = await newDevice(srv, await newUser(srv), { name: 'D', vault: 'create' });
  await remoteCommit(d, 'kept.md', text('kept\n'));
  await remoteCommit(d, 'changed.md', text('v1\n'));
  await remoteCommit(d, 'gone.md', text('bye\n'));
  await pull(d.ctx);
  d.adapter.writeSilently('changed.md', text('v2\n'));
  d.adapter.removeSilently('gone.md');
  d.adapter.writeSilently('new.md', text('new\n'));
  d.adapter.writeSilently('.obsidian/workspace.json', text('{}'));
  expect(await reconcile(d.ctx)).toEqual({ fetched: 0, markedDirty: 3, vaultSeq: 3, shadowed: 0 });
  expect((await d.state.dirtyEntries()).map((e) => e.path).sort()).toEqual(['changed.md', 'gone.md', 'new.md']);
  await pushRound(d.ctx, new PushMemory());
  const heads = (await d.api.heads(d.vaultId, null)).heads;
  expect(heads.filter((h) => h.deleted)).toHaveLength(1);
  expect(heads).toHaveLength(4);
});

it('applies remote heads this device never saw', async () => {
  const user = await newUser(srv);
  const d = await newDevice(srv, user, { name: 'D', vault: 'create' });
  await remoteCommit(d, 'a.md', text('a\n'));
  await d.state.setCursorAndAnchor(1, null); // pretend the change log was read, but it was never applied
  await reconcile(d.ctx);
  expect(files(d.adapter)).toEqual({ 'a.md': 'a\n' });
});

it('re-queues a pending commit whose dirty entry was lost', async () => {
  const d = await newDevice(srv, await newUser(srv), { name: 'D', vault: 'create' });
  await d.adapter.write('a.md', text('a\n'));
  await d.state.markDirty('a.md');
  d.net.setOnline(false); // the pending commit is stored, then the upload fails
  await expect(pushRound(d.ctx, new PushMemory())).rejects.toThrow();
  expect(await d.state.allPending()).toHaveLength(1);
  const [entry] = await d.state.dirtyEntries();
  await d.state.clearDirty(entry!.path, entry!.gen);
  d.net.setOnline(true);
  await reconcile(d.ctx);
  expect((await d.state.dirtyEntries()).map((e) => e.path)).toEqual(['a.md']);
});

it('queues a file it cannot stat instead of failing, and push reports it for that file only', async () => {
  const d = await newDevice(srv, await newUser(srv), { name: 'D', vault: 'create' });
  await remoteCommit(d, 'bad.md', text('bad\n'));
  await remoteCommit(d, 'ok.md', text('ok\n'));
  await pull(d.ctx);
  d.adapter.writeSilently('ok.md', text('ok 2\n'));
  d.adapter.failReads('bad.md', true, { stat: true });
  expect(await reconcile(d.ctx)).toEqual({ fetched: 0, markedDirty: 2, vaultSeq: 2, shadowed: 0 });
  expect(await pushRound(d.ctx, new PushMemory())).toMatchObject({ committed: 1 });
  expect(d.events).toContainEqual(expect.objectContaining({ type: 'notice', code: 'FILE_FAILED', path: 'bad.md' }));
});

it('adopts its own landed commit from the history before applying a newer head', async () => {
  const { a, y } = await landedPendingOvertakenTwice(srv);
  // The change log was read but the versions were not applied (e.g. the file failed then).
  await a.state.setCursorAndAnchor((await a.api.changes(a.vaultId, 0)).vaultSeq, null);
  await reconcile(a.ctx);
  expect(a.events.filter((e) => e.type === 'conflict')).toEqual([]);
  expect(files(a.adapter)).toEqual({ 'a.md': 'base\nmine\ntheirs\nmore\n' });
  expect(await a.state.allPending()).toEqual([]);
  await pushRound(a.ctx, new PushMemory());
  expect((await a.api.heads(a.vaultId, null)).heads.map((h) => toHex(h.versionId))).toEqual([y]);
});

it('queues a file whose size changed without reading it, and reads only same-size files to compare', async () => {
  const d = await newDevice(srv, await newUser(srv), { name: 'D', vault: 'create' });
  await remoteCommit(d, 'grown.md', text('small\n'));
  await remoteCommit(d, 'touched.md', text('same\n'));
  await pull(d.ctx);
  d.adapter.writeSilently('grown.md', text('much larger now\n'));
  d.adapter.writeSilently('touched.md', text('same\n')); // same content, new mtime
  const read = vi.spyOn(d.adapter, 'read');
  expect(await reconcile(d.ctx)).toMatchObject({ markedDirty: 1 });
  expect(read.mock.calls.map((c) => c[0])).toEqual(['touched.md']);
  expect((await d.state.dirtyEntries()).map((e) => e.path)).toEqual(['grown.md']);
});

it('tells the adapter which folders its ignore rules skip, so ignored trees are not walked', async () => {
  const d = await newDevice(srv, await newUser(srv), { name: 'D', vault: 'create', ignoreGlobs: ['Scratch/'] });
  await d.adapter.write('Notes/a.md', text('a\n'));
  await d.adapter.write('Scratch/b.md', text('b\n'));
  await d.adapter.write('.git/objects/ab', text('g\n'));
  let skip: ((folder: string) => boolean) | undefined;
  const list = d.adapter.list.bind(d.adapter);
  d.adapter.list = async (s) => {
    skip = s;
    return list(s);
  };
  await reconcile(d.ctx);
  expect(skip).toBeDefined();
  expect([skip!('Scratch'), skip!('.git'), skip!('Notes'), skip!('Notes/Deep')]).toEqual([true, true, false, false]);
  expect((await d.state.dirtyEntries()).map((e) => e.path)).toEqual(['Notes/a.md']);
});

it('does not trust an unchanged size and mtime when mtimes are whole seconds: it compares the content', async () => {
  // A file system that keeps whole seconds (FAT, some Android storage): an edit within the same second keeps the mtime.
  const d = await newDevice(srv, await newUser(srv), { name: 'D', vault: 'create', coarseMtime: true });
  await d.adapter.write('x.md', text('one\n'));
  await d.state.markDirty('x.md');
  await pushRound(d.ctx, new PushMemory());
  expect(await reconcile(d.ctx)).toMatchObject({ markedDirty: 0 }); // nothing changed
  d.adapter.writeSilently('x.md', text('two\n')); // same size, same whole second
  expect(await reconcile(d.ctx)).toMatchObject({ markedDirty: 1 });
});

describe('with whole-second mtimes', () => {
  /** A device whose adapter keeps whole seconds and counts reads per path. */
  async function coarseDevice() {
    const user = await newUser(srv);
    const d = await newDevice(srv, user, { name: 'D', vault: 'create', coarseMtime: true });
    const reads: string[] = [];
    const read = d.adapter.read.bind(d.adapter);
    d.adapter.read = async (p) => {
      reads.push(p);
      return read(p);
    };
    const clock = d.clock as ManualClock;
    const push = async (path: string, content: string) => {
      await d.adapter.write(path, text(content));
      await d.state.markDirty(path);
      await pushRound(d.ctx, new PushMemory());
    };
    return { d, user, reads, clock, push };
  }

  it('reads no file of an unchanged vault once its records are older than two seconds', async () => {
    const { d, reads, clock, push } = await coarseDevice();
    for (const p of ['a.md', 'b.md', 'c.md']) await push(p, `${p}\n`);
    clock.advance(3000);
    reads.length = 0;
    expect(await reconcile(d.ctx)).toMatchObject({ markedDirty: 0 });
    expect(reads.sort()).toEqual(['a.md', 'b.md', 'c.md']); // pushed within their mtime's second: read once more
    reads.length = 0;
    expect(await reconcile(d.ctx)).toMatchObject({ markedDirty: 0 });
    expect(reads).toEqual([]);
  });

  it('still finds a same-size edit made in the same second as the record, and pushes it', async () => {
    const { d, user, reads, push } = await coarseDevice();
    await push('x.md', 'one\n');
    const mtime = (await d.adapter.stat('x.md'))!.mtime;
    d.adapter.writeSilently('x.md', text('two\n'));
    expect((await d.adapter.stat('x.md'))!.mtime).toBe(mtime); // invisible to size and mtime
    reads.length = 0;
    expect(await reconcile(d.ctx)).toMatchObject({ markedDirty: 1 });
    expect(reads).toEqual(['x.md']);
    await pushRound(d.ctx, new PushMemory());
    const other = await newDevice(srv, user, { name: 'E', vault: d.vaultId });
    await pull(other.ctx);
    expect(files(other.adapter)).toEqual({ 'x.md': 'two\n' });
  });

  it('reads a record from before the check time was kept once, then skips it, without pushing', async () => {
    const { d, reads, clock, push } = await coarseDevice();
    await push('x.md', 'one\n');
    const [rec] = await d.state.filesByPath('x.md');
    const legacy: FileRecord = { ...rec! };
    delete legacy.localCheckedAt;
    await d.state.putFile(legacy);
    clock.advance(3000);
    reads.length = 0;
    expect(await reconcile(d.ctx)).toMatchObject({ markedDirty: 0 });
    expect(reads).toEqual(['x.md']);
    expect((await d.state.filesByPath('x.md'))[0]?.localCheckedAt).toBe(clock.now());
    reads.length = 0;
    expect(await reconcile(d.ctx)).toMatchObject({ markedDirty: 0 });
    expect(reads).toEqual([]);
    expect(await d.state.allPending()).toEqual([]);
    expect((await d.api.heads(d.vaultId, null)).heads).toHaveLength(1);
  });
});
