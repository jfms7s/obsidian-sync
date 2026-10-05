// ApiClient against the real server: the wire contract as built.
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { ApiClient } from '../../src/api/client';
import { ErrorCode, NetworkError } from '../../src/api/errors';
import type { KeyBundleFields } from '../../src/api/types';
import { seededRandom } from '../../src/util/random';
import { Net } from '../helpers/net';
import { startServer, type TestServer } from '../helpers/server';

let srv: TestServer;
beforeAll(async () => {
  srv = await startServer(inject('obsyncBin'));
  await srv.createUser('alice', 'alice-password');
});
afterAll(() => srv?.stop());

const r = seededRandom(1);
const bundle = (): KeyBundleFields => ({
  publicEncKey: r.bytes(32), publicSignKey: r.bytes(32), passSalt: r.bytes(16),
  passParams: { memoryKib: 8192, iterations: 1, parallelism: 1 }, passWrapped: r.bytes(92), recoveryWrapped: r.bytes(92),
});

describe('ApiClient against obsync', () => {
  let api: ApiClient;
  beforeAll(async () => {
    api = new ApiClient({ baseUrl: srv.url });
    await api.login('alice', 'alice-password', 'test device', 'node');
  });

  it('rejects a wrong password with UNAUTHORIZED', async () => {
    await expect(new ApiClient({ baseUrl: srv.url }).login('alice', 'nope', 'd', 'p')).rejects.toMatchObject({ code: ErrorCode.UNAUTHORIZED, status: 401 });
  });

  it('follows the key bundle replacement rules', async () => {
    expect(await api.getKeyBundle()).toBeNull();
    const first = bundle();
    await api.putKeyBundle(first);
    await api.putKeyBundle(first); // an identical re-send needs no password
    const changed = { ...first, passSalt: r.bytes(16) };
    await expect(api.putKeyBundle(changed)).rejects.toMatchObject({ code: ErrorCode.WRONG_PASSWORD, status: 403 });
    await expect(api.putKeyBundle(changed, 'wrong')).rejects.toMatchObject({ code: ErrorCode.WRONG_PASSWORD });
    await api.putKeyBundle(changed, 'alice-password');
    expect((await api.getKeyBundle())?.passSalt).toEqual(changed.passSalt);
    await expect(api.putKeyBundle({ ...changed, publicEncKey: r.bytes(32) }, 'alice-password')).rejects.toMatchObject({ code: ErrorCode.INVALID });
  });

  it('creates a vault, stores chunks and commits versions', async () => {
    const vaultId = '0123456789abcdef0123456789abcdef';
    const v = await api.createVault(vaultId, r.bytes(40), [{ epoch: 0, sealedKey: r.bytes(92) }, { epoch: 1, sealedKey: r.bytes(92) }]);
    expect(v).toMatchObject({ vaultId, currentEpoch: 1, seq: 0 });
    expect((await api.vaultKeys(vaultId)).map((k) => k.epoch).sort()).toEqual([0, 1]);

    const chunkId = r.bytes(32);
    const sealed = r.bytes(100);
    expect(await api.chunksExist(vaultId, [chunkId])).toEqual([false]);
    await api.putChunk(vaultId, chunkId, sealed);
    expect(await api.chunksExist(vaultId, [chunkId])).toEqual([true]);
    expect(await api.getChunk(vaultId, chunkId)).toEqual(sealed);

    const fileId = r.bytes(32);
    const commit = { fileId, versionId: r.bytes(16), baseVersionId: new Uint8Array(0), epoch: 1, encMeta: r.bytes(50), chunkIds: [chunkId], size: 60, deleted: false };
    const reply = await api.commit(vaultId, [commit]);
    expect(reply.results[0]).toMatchObject({ ok: true, seq: 1 });
    // An exact retry (enc_meta may differ) returns the original seq.
    expect((await api.commit(vaultId, [{ ...commit, encMeta: r.bytes(50) }])).results[0]).toMatchObject({ ok: true, seq: 1 });
    // A new file at the same id without a base conflicts with the head.
    const clash = await api.commit(vaultId, [{ ...commit, versionId: r.bytes(16) }]);
    expect(clash.results[0]).toMatchObject({ ok: false, error: { code: ErrorCode.CONFLICT } });
    expect(clash.results[0]!.headVersionId).toEqual(commit.versionId);
    // A deletion carries no chunks; re-creating needs the tombstone as base.
    const tomb = { fileId, versionId: r.bytes(16), baseVersionId: commit.versionId, epoch: 1, encMeta: r.bytes(50), chunkIds: [], size: 0, deleted: true };
    expect((await api.commit(vaultId, [tomb])).results[0]).toMatchObject({ ok: true, seq: 2 });
    const again = await api.commit(vaultId, [{ ...commit, versionId: r.bytes(16), baseVersionId: new Uint8Array(0) }]);
    expect(again.results[0]!.headVersionId).toEqual(tomb.versionId);

    const changes = await api.changes(vaultId, 0, 1);
    expect(changes).toMatchObject({ vaultSeq: 2, more: true });
    expect(changes.versions[0]!.chunkIds).toEqual([chunkId]);
    expect((await api.heads(vaultId, null)).heads).toEqual([{ fileId, versionId: tomb.versionId, seq: 2, deleted: true }]);
    expect((await api.history(vaultId, fileId)).map((x) => x.seq)).toEqual([2, 1]);
    expect((await api.trash(vaultId)).map((x) => x.seq)).toEqual([2]);
    expect((await api.changes(vaultId, 5)).vaultSeq).toBe(2); // the rollback signal: vault_seq < since
  });

  it('surfaces a lost response as NetworkError although the server applied the request', async () => {
    const net = new Net();
    const lossy = new ApiClient({ baseUrl: srv.url, token: api.token!, fetch: net.fetch });
    net.loseNextResponse('POST', '/v1/vaults');
    const vaultId = 'abcdefabcdefabcdefabcdefabcdef12';
    await expect(lossy.createVault(vaultId, r.bytes(40), [{ epoch: 0, sealedKey: r.bytes(92) }, { epoch: 1, sealedKey: r.bytes(92) }]))
      .rejects.toBeInstanceOf(NetworkError);
    expect((await api.listVaults()).map((v) => v.vaultId)).toContain(vaultId);
    expect(net.count('POST', '/v1/vaults')).toBe(1);
  });

  it('lists devices and logs out', async () => {
    const other = new ApiClient({ baseUrl: srv.url });
    await other.login('alice', 'alice-password', 'second', 'node');
    expect((await other.listDevices()).filter((d) => d.current).map((d) => d.name)).toEqual(['second']);
    await other.logout();
    await expect(other.listDevices()).rejects.toMatchObject({ code: ErrorCode.DEVICE_REVOKED });
  });
});
