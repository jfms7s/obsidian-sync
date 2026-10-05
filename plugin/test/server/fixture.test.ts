// The device fixture and fault-injecting network the sync tests build on.
import { afterAll, beforeAll, expect, inject, it } from 'vitest';
import { NetworkError } from '../../src/api/errors';
import { decryptMeta } from '../../src/crypto/objects';
import { newDevice, newUser, remoteCommit, text } from '../helpers/fixture';
import { startServer, type TestServer } from '../helpers/server';

let srv: TestServer;
beforeAll(async () => {
  srv = await startServer(inject('obsyncBin'));
});
afterAll(() => srv?.stop());

it('gives two devices of one user the same vault keys, and remoteCommit lands encrypted', async () => {
  const user = await newUser(srv);
  const a = await newDevice(srv, user, { name: 'A', vault: 'create' });
  const b = await newDevice(srv, user, { name: 'B', vault: a.vaultId });
  expect(b.vaultId).toBe(a.vaultId);
  expect(b.ring.namingKey).toEqual(a.ring.namingKey);
  await remoteCommit(a, 'x.md', text('x\n'));
  await remoteCommit(a, 'x.md', null);
  const page = await b.api.changes(b.vaultId, 0);
  const metas = await Promise.all(page.versions.map((v) => decryptMeta(b.ring, v.epoch, v.fileId, v.versionId, v.encMeta)));
  expect(metas.map((m) => [m.path, m.size])).toEqual([['x.md', 2], ['x.md', 0]]);
  expect(page.versions[1]!.baseVersionId).toEqual(page.versions[0]!.versionId);
});

it('can take a device offline', async () => {
  const d = await newDevice(srv, await newUser(srv), { name: 'D', vault: 'create' });
  d.net.setOnline(false);
  await expect(d.api.listVaults()).rejects.toBeInstanceOf(NetworkError);
  d.net.setOnline(true);
  expect(await d.api.listVaults()).toHaveLength(1);
});
