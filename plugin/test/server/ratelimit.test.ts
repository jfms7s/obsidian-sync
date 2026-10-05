// The server's per-device rate limit, switched on, against the client's Retry-After handling.
import { afterAll, beforeAll, expect, inject, it } from 'vitest';
import { ApiClient } from '../../src/api/client';
import { ErrorCode } from '../../src/api/errors';
import { Net } from '../helpers/net';
import { startServer, type TestServer } from '../helpers/server';

let srv: TestServer;
beforeAll(async () => {
  srv = await startServer(inject('obsyncBin'), { env: { OBSYNC_RATE_LIMIT_DEVICE_RPS: '1', OBSYNC_RATE_LIMIT_DEVICE_BURST: '3' } });
  await srv.createUser('busy', 'busy-password');
});
afterAll(() => srv?.stop());

it('gets 429 with Retry-After, sends nothing until it has passed, then succeeds', async () => {
  const net = new Net();
  const api = new ApiClient({ baseUrl: srv.url, fetch: net.fetch });
  await api.login('busy', 'busy-password', 'test', 'node');
  for (let i = 0; i < 3; i++) await api.listVaults(); // the burst
  const err = await api.listVaults().catch((e: unknown) => e);
  expect(err).toMatchObject({ code: ErrorCode.RATE_LIMITED, status: 429 });
  const wait = (err as { retryAfterMs: number }).retryAfterMs;
  expect(wait).toBeGreaterThanOrEqual(1000);
  const sent = net.count('GET', '/v1/vaults');
  await expect(api.listVaults()).rejects.toMatchObject({ code: ErrorCode.RATE_LIMITED });
  expect(net.count('GET', '/v1/vaults')).toBe(sent); // held back by the gate, never sent
  await new Promise((r) => setTimeout(r, wait + 100)); // margin: timers may fire a little early relative to the server's clock
  expect(await api.listVaults()).toEqual([]);
});
