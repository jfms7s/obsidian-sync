// A start, or a reconnect, reconciles once (spec §5.6): the reconcile is a
// full heads listing and a pass over every local file, so doing it twice
// for one event doubles the cost of every start on a phone.
import { afterAll, beforeAll, expect, inject, it } from 'vitest';
import { systemClock } from '../../src/util/clock';
import { makeClient, type SimClient } from '../helpers/client';
import { newUser } from '../helpers/fixture';
import { startServer, type TestServer } from '../helpers/server';

let srv: TestServer;
beforeAll(async () => {
  srv = await startServer(inject('obsyncBin'));
});
afterAll(() => srv?.stop());

async function waitFor(cond: () => boolean | Promise<boolean>, ms: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`condition not met within ${ms} ms`);
}

/** Lets anything the connection triggered run to its end. */
async function quiet(c: SimClient): Promise<void> {
  await new Promise((r) => setTimeout(r, 300));
  await c.engine.whenIdle();
}

/** Reconciles so far: each lists the server's heads (a plain pull reads the change log). */
const reconciles = (c: SimClient) => c.net.log.filter((r) => r.method === 'GET' && r.path.endsWith('/heads')).length;

it('reconciles once at start and once per reconnect', async () => {
  const c = await makeClient(srv, await newUser(srv), { name: 'A', vault: 'create', clock: systemClock, autoRun: true, webSocket: true });
  await waitFor(() => c.engine.status === 'synced' && c.net.openSockets === 1, 5000);
  await quiet(c);
  expect(reconciles(c)).toBe(1);

  c.net.setOnline(false);
  await waitFor(() => c.net.openSockets === 0, 5000);
  await new Promise((r) => setTimeout(r, 100)); // a few failed reconnect attempts
  c.net.setOnline(true);
  await waitFor(() => c.net.openSockets === 1 && reconciles(c) >= 2, 5000);
  await quiet(c);
  expect(reconciles(c)).toBe(2);
  expect(c.engine.status).toBe('synced');
  await c.engine.stop();
});
