// Reconcile (spec §5.6): catching what events missed.
import { afterAll, beforeAll, expect, inject, it } from 'vitest';
import { pull } from '../../src/sync/pull';
import { PushMemory, pushRound } from '../../src/sync/push';
import { reconcile } from '../../src/sync/reconcile';
import { files, newDevice, newUser, remoteCommit, text } from '../helpers/fixture';
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
  expect(await reconcile(d.ctx)).toEqual({ fetched: 0, markedDirty: 3 });
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
  expect(await reconcile(d.ctx)).toEqual({ fetched: 0, markedDirty: 2 });
  expect(await pushRound(d.ctx, new PushMemory())).toMatchObject({ committed: 1 });
  expect(d.events).toContainEqual(expect.objectContaining({ type: 'notice', code: 'FILE_FAILED', path: 'bad.md' }));
});
