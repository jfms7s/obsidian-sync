// HubClient against the real server's WebSocket hub.
import { afterAll, beforeAll, expect, inject, it } from 'vitest';
import { ApiClient } from '../../src/api/client';
import { ErrorCode } from '../../src/api/errors';
import { defaultWebSocketFactory, HubClient } from '../../src/api/hub';
import { hubUrl } from '../../src/api/url';
import { systemClock } from '../../src/util/clock';
import { seededRandom } from '../../src/util/random';
import { startServer, type TestServer } from '../helpers/server';

let srv: TestServer;
beforeAll(async () => {
  srv = await startServer(inject('obsyncBin'));
  await srv.createUser('hubuser', 'hub-password');
});
afterAll(() => srv?.stop());

async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

it('authenticates, receives the current seq and live notifications, and stops when revoked', async () => {
  const api = new ApiClient({ baseUrl: srv.url });
  await api.login('hubuser', 'hub-password', 'hub test', 'node');
  const r = seededRandom(2);
  const vaultId = 'aaaabbbbccccddddeeeeffff00001111';
  await api.createVault(vaultId, r.bytes(40), [{ epoch: 0, sealedKey: r.bytes(92) }, { epoch: 1, sealedKey: r.bytes(92) }]);

  const seen: string[] = [];
  const hub = new HubClient(
    { url: hubUrl(srv.url), token: api.token!, vaultIds: [vaultId], connect: defaultWebSocketFactory, clock: systemClock, random: r },
    {
      onNotify: (v, seq) => seen.push(`notify ${v === vaultId} ${seq}`),
      onConnected: () => seen.push('connected'),
      onDisconnected: () => seen.push('disconnected'),
      onAuthFailure: (code) => seen.push(`auth ${ErrorCode[code]}`),
      onVaultNotFound: () => seen.push('vault lost'),
    },
  );
  hub.start();
  await until(() => seen.includes('notify true 0'));
  await api.commit(vaultId, [{ fileId: r.bytes(32), versionId: r.bytes(16), baseVersionId: new Uint8Array(0), epoch: 1, encMeta: r.bytes(20), chunkIds: [], size: 0, deleted: false }]);
  await until(() => seen.includes('notify true 1'));
  expect(seen.slice(0, 2)).toEqual(['connected', 'notify true 0']);

  const admin = new ApiClient({ baseUrl: srv.url });
  await admin.login('hubuser', 'hub-password', 'admin', 'node');
  await admin.revokeDevice((await api.listDevices()).find((d) => d.current)!.deviceId);
  hub.stop();
  // A revoked token is refused in the first frame of a new socket, and the
  // client gives up instead of reconnecting.
  const again = new HubClient(
    { url: hubUrl(srv.url), token: api.token!, vaultIds: [vaultId], connect: defaultWebSocketFactory, clock: systemClock, random: r },
    { onNotify: () => undefined, onConnected: () => seen.push('reconnected'), onDisconnected: () => undefined, onAuthFailure: (code) => seen.push(`auth ${ErrorCode[code]}`), onVaultNotFound: () => undefined },
  );
  again.start();
  await until(() => seen.some((s) => s.startsWith('auth')));
  expect(seen).toContain('auth DEVICE_REVOKED');
  expect(seen).not.toContain('reconnected');
  again.stop();
});
