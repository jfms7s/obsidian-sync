// Reconcile (spec §5.6): catching what events missed.
import { afterAll, beforeAll, expect, inject, it, vi } from 'vitest';
import { toHex } from '../../src/util/bytes';
import { pull } from '../../src/sync/pull';
import { PushMemory, pushRound } from '../../src/sync/push';
import { reconcile } from '../../src/sync/reconcile';
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
