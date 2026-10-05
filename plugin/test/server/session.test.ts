// openSyncSession: what plan 3's onload calls to get an engine, or the setup step still missing.
import { IDBFactory } from 'fake-indexeddb';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';
import { apiFor, login, setupKeys } from '../../src/services/account';
import { openSyncSession } from '../../src/services/session';
import { createVault } from '../../src/services/vaults';
import { LocalState } from '../../src/state/store';
import { seededRandom } from '../../src/util/random';
import { MemoryAdapter } from '../../src/vault/memory';
import { startServer, type TestServer } from '../helpers/server';

let srv: TestServer;
beforeAll(async () => {
  srv = await startServer(inject('obsyncBin'));
  await srv.createUser('sam', 'sam-password');
});
afterAll(() => srv?.stop());

it('reports the missing step, then starts an engine that syncs', async () => {
  const state = await LocalState.open(new IDBFactory(), 'session');
  const adapter = new MemoryAdapter();
  const open = () => openSyncSession({ state, adapter, webSocket: null, autoRun: false });
  expect(await open()).toEqual({ ok: false, reason: 'not-logged-in' });
  const session = await login(state, srv.url, 'sam', 'sam-password', 'Laptop', 'linux');
  expect(await open()).toEqual({ ok: false, reason: 'locked' });
  const api = apiFor(session);
  const { keys } = await setupKeys(state, api, session, 'pp', seededRandom(1), { memoryKib: 8192, iterations: 1, parallelism: 1 });
  expect(await open()).toEqual({ ok: false, reason: 'no-vault' });
  await createVault(state, api, session, keys, 'Notes', seededRandom(2));
  const opened = await open();
  if (!opened.ok) throw new Error(opened.reason);
  await opened.engine.start();
  await adapter.write('hello.md', new TextEncoder().encode('hi\n'));
  await opened.engine.runCycle();
  expect(opened.engine.status).toBe('synced');
  expect((await api.heads((await state.getVault())!.vaultId, null)).heads).toHaveLength(1);
  await opened.engine.stop();
});

it('applies the stored ignore globs, case-insensitively on a case-insensitive adapter', async () => {
  await srv.createUser('ivy', 'ivy-password');
  const state = await LocalState.open(new IDBFactory(), 'session-ignore');
  const adapter = new MemoryAdapter(true);
  const session = await login(state, srv.url, 'ivy', 'ivy-password', 'Mac', 'darwin');
  const api = apiFor(session);
  const { keys } = await setupKeys(state, api, session, 'pp', seededRandom(3), { memoryKib: 8192, iterations: 1, parallelism: 1 });
  await createVault(state, api, session, keys, 'Notes', seededRandom(4));
  await state.setSetting('ignoreGlobs', ['private/']);
  const opened = await openSyncSession({ state, adapter, webSocket: null, autoRun: false });
  if (!opened.ok) throw new Error(opened.reason);
  await opened.engine.start();
  await adapter.write('Private/secret.md', new TextEncoder().encode('no\n'));
  await adapter.write('public.md', new TextEncoder().encode('yes\n'));
  await opened.engine.runCycle();
  expect((await api.heads((await state.getVault())!.vaultId, null)).heads).toHaveLength(1);
  await opened.engine.stop();
});

it("does not start syncing another account's stored vault", async () => {
  await srv.createUser('ann', 'ann-password');
  await srv.createUser('bob', 'bob-password');
  const state = await LocalState.open(new IDBFactory(), 'session-other-user');
  const adapter = new MemoryAdapter();
  const ann = await login(state, srv.url, 'ann', 'ann-password', 'Laptop', 'linux');
  const annKeys = (await setupKeys(state, apiFor(ann), ann, 'pp', seededRandom(5), { memoryKib: 8192, iterations: 1, parallelism: 1 })).keys;
  await createVault(state, apiFor(ann), ann, annKeys, 'Ann notes', seededRandom(6));
  // Bob logs in on the same device without Ann logging out first.
  const bob = await login(state, srv.url, 'bob', 'bob-password', 'Laptop', 'linux');
  await setupKeys(state, apiFor(bob), bob, 'pp', seededRandom(7), { memoryKib: 8192, iterations: 1, parallelism: 1 });
  expect(await openSyncSession({ state, adapter, webSocket: null, autoRun: false })).toEqual({ ok: false, reason: 'no-vault' });
});
