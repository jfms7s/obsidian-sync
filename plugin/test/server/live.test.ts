// Real time: autonomous engines with WebSockets, real timers (spec §1.2:
// edits appear on other online devices within a few seconds).
import { afterAll, beforeAll, expect, inject, it } from 'vitest';
import { systemClock } from '../../src/util/clock';
import { makeClient, type SimClient } from '../helpers/client';
import { files, text } from '../helpers/fixture';
import { startServer, type TestServer } from '../helpers/server';

let srv: TestServer;
beforeAll(async () => {
  srv = await startServer(inject('obsyncBin'));
  await srv.createUser('live', 'live-password');
});
afterAll(() => srv?.stop());

async function waitFor(cond: () => boolean | Promise<boolean>, ms: number): Promise<number> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await cond()) return Date.now() - start;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`condition not met within ${ms} ms`);
}

it('delivers an edit to another online device within 5 s and stops a revoked device', async () => {
  const user = { username: 'live', password: 'live-password' };
  const opts = { clock: systemClock, autoRun: true, webSocket: true };
  const a: SimClient = await makeClient(srv, user, { ...opts, name: 'A', vault: 'create' });
  const b: SimClient = await makeClient(srv, user, { ...opts, name: 'B', vault: a.vaultId });
  await waitFor(() => a.engine.status === 'synced' && b.engine.status === 'synced', 5000);

  await a.adapter.write('live.md', text('hello\n'));
  const took = await waitFor(() => files(b.adapter)['live.md'] === 'hello\n', 5000);
  expect(took).toBeLessThan(5000);

  await a.api.revokeDevice(b.session.deviceId);
  // The hub revalidates the token on b's next frame (its 30 s ping) and the
  // next request fails at once; a local edit triggers one.
  await b.adapter.write('after.md', text('x\n'));
  await waitFor(() => b.events.some((e) => e.type === 'notice' && e.code === 'DEVICE_REVOKED'), 5000);
  await a.engine.stop();
  await b.engine.stop();
});
