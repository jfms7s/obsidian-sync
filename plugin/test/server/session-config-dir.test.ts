import { afterAll, beforeAll, expect, inject, it } from 'vitest';
import { openSyncSession } from '../../src/services/session';
import { files, newDevice, newUser, text } from '../helpers/fixture';
import { makeClient, settle } from '../helpers/client';
import { startServer, type TestServer } from '../helpers/server';

let srv: TestServer;
beforeAll(async () => {
  srv = await startServer(inject('obsyncBin'));
});
afterAll(() => srv?.stop());

it('ignores the vault\'s configuration folder under its real name, not only .obsidian', async () => {
  const user = await newUser(srv);
  const dev = await newDevice(srv, user, { name: 'Laptop', vault: 'create' });
  const other = await makeClient(srv, user, { name: 'Phone', vault: dev.vaultId });
  const r = await openSyncSession({ state: dev.state, adapter: dev.adapter, webSocket: null, fetch: dev.net.fetch, clock: dev.clock, random: dev.random, autoRun: false, configDir: '.obsidian-mobile' });
  if (!r.ok) throw new Error(r.reason);
  await dev.adapter.write('.obsidian-mobile/workspace.json', text('{}'));
  await dev.adapter.write('.obsidian/app.json', text('{}'));
  await dev.adapter.write('note.md', text('n\n'));
  await r.engine.start();
  await r.engine.runCycle();
  await settle([other]);
  expect(files(other.adapter)).toEqual({ 'note.md': 'n\n' });
  await r.engine.stop();
});
