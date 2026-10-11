// Server maintenance (history pruning, trash purge, chunk GC) end to end:
// `obsync admin maintenance run --as-of` makes the server's data a month
// older between two client actions.
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { fileHistory, listTrash, readVersion, restore } from '../../src/services/history';
import { keyringFromStored } from '../../src/services/vaults';
import { makeClient, settle } from '../helpers/client';
import { files, newUser, text } from '../helpers/fixture';
import { startServer, type TestServer } from '../helpers/server';

const DAY = 24 * 60 * 60 * 1000;
/** Past the default retention (30 days of history, 30 days of trash, 24 h GC grace). */
const monthLater = () => new Date(Date.now() + 31 * DAY);

let srv: TestServer;
beforeAll(async () => {
  srv = await startServer(inject('obsyncBin'));
});
afterAll(() => srv?.stop());

describe('server maintenance', () => {
  it('prunes old history: the old version is gone and restoring it fails without touching the vault', async () => {
    const user = await newUser(srv);
    const a = await makeClient(srv, user, { name: 'A', vault: 'create' });
    const b = await makeClient(srv, user, { name: 'B', vault: a.vaultId });
    const ring = await keyringFromStored((await a.state.getVault())!);
    await a.adapter.write('n.md', text('v1\n'));
    await settle([a, b]);
    await a.adapter.write('n.md', text('v2\n'));
    await settle([a, b]);
    const before = await fileHistory(a.api, ring, 'n.md');
    expect(before).toHaveLength(2);

    expect(await srv.maintenance(monthLater())).toMatch(/1 version pruned/);

    const after = await fileHistory(a.api, ring, 'n.md');
    expect(after.map((h) => h.version.versionId)).toEqual([before[0]!.version.versionId]);
    // A history view opened before the pass still lists v1: reading or restoring it fails cleanly.
    await expect(readVersion(a.api, ring, before[1]!)).rejects.toThrow(/missing part of this version/);
    await expect(restore(a.api, ring, a.adapter, a.state, before[1]!)).rejects.toThrow(/missing part of this version/);
    await settle([a, b]);
    expect(files(a.adapter)).toEqual({ 'n.md': 'v2\n' });
    expect(files(b.adapter)).toEqual({ 'n.md': 'v2\n' });
  });

  it('purges the trash: the deleted file is no longer listed and a stale entry cannot be restored', async () => {
    const user = await newUser(srv);
    const a = await makeClient(srv, user, { name: 'A', vault: 'create' });
    const b = await makeClient(srv, user, { name: 'B', vault: a.vaultId });
    const ring = await keyringFromStored((await a.state.getVault())!);
    await a.adapter.write('gone.md', text('bye\n'));
    await a.adapter.write('kept.md', text('stay\n'));
    await settle([a, b]);
    await b.adapter.remove('gone.md');
    await settle([a, b]);
    const trash = await listTrash(a.api, ring);
    expect(trash.map((t) => t.meta?.path)).toEqual(['gone.md']);

    expect(await srv.maintenance(monthLater())).toMatch(/1 file purged/);

    expect(await listTrash(a.api, ring)).toEqual([]);
    await expect(restore(a.api, ring, a.adapter, a.state, trash[0]!)).rejects.toThrow(/no restorable version is left/);
    await settle([a, b]);
    expect(files(a.adapter)).toEqual({ 'kept.md': 'stay\n' });
    expect(files(b.adapter)).toEqual({ 'kept.md': 'stay\n' });
  });

  it('collects the chunk of a commit that never reached the server, and the device uploads it again', async () => {
    const user = await newUser(srv);
    const a = await makeClient(srv, user, { name: 'A', vault: 'create' });
    const b = await makeClient(srv, user, { name: 'B', vault: a.vaultId });
    await a.adapter.write('late.md', text('written before a long time offline\n'));
    a.net.failNextRequest('POST', '/commit');
    await a.engine.runCycle(); // the chunk is uploaded, the commit never arrives
    expect(await a.state.allPending()).toHaveLength(1);

    // The device stays away for a month; the uploaded chunk, referenced by
    // no version, is collected.
    expect(await srv.maintenance(monthLater())).toMatch(/1 chunk deleted/);

    await settle([a, b]);
    expect(files(b.adapter)).toEqual({ 'late.md': 'written before a long time offline\n' });
    expect(await a.state.allPending()).toEqual([]);
  });
});
