// History, trash and restore (what plan 3's history view calls), against the real server.
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { fileHistory, listTrash, readVersion, restore, UnsyncedChangesError } from '../../src/services/history';
import { keyringFromStored } from '../../src/services/vaults';
import { makeClient, settle } from '../helpers/client';
import { files, newUser, text } from '../helpers/fixture';
import { startServer, type TestServer } from '../helpers/server';

let srv: TestServer;
beforeAll(async () => {
  srv = await startServer(inject('obsyncBin'));
});
afterAll(() => srv?.stop());

describe('history and trash', () => {
  it('lists versions, reads one, and restores an earlier version and a deleted file', async () => {
    const user = await newUser(srv);
    const a = await makeClient(srv, user, { name: 'A', vault: 'create' });
    const b = await makeClient(srv, user, { name: 'B', vault: a.vaultId });
    const ring = await keyringFromStored((await a.state.getVault())!);
    await a.adapter.write('n.md', text('v1\n'));
    await settle([a, b]);
    await a.adapter.write('n.md', text('v2\n'));
    await settle([a, b]);
    const hist = await fileHistory(a.api, ring, 'n.md');
    expect(hist.map((h) => h.meta?.size)).toEqual([3, 3]);
    expect(new TextDecoder().decode(await readVersion(a.api, ring, hist[1]!))).toBe('v1\n');
    await restore(a.api, ring, a.adapter, a.state, hist[1]!);
    await settle([a, b]);
    expect(files(b.adapter)).toEqual({ 'n.md': 'v1\n' });

    await b.adapter.remove('n.md');
    await settle([a, b]);
    const trash = await listTrash(a.api, ring);
    expect(trash.map((t) => t.meta?.path)).toEqual(['n.md']);
    expect(await restore(a.api, ring, a.adapter, a.state, trash[0]!)).toBe('n.md');
    await settle([a, b]);
    expect(files(b.adapter)).toEqual({ 'n.md': 'v1\n' });
    expect(await listTrash(a.api, ring)).toEqual([]);
  });

  it('refuses to overwrite unsynced local changes', async () => {
    const user = await newUser(srv);
    const a = await makeClient(srv, user, { name: 'A', vault: 'create' });
    const ring = await keyringFromStored((await a.state.getVault())!);
    await a.adapter.write('n.md', text('v1\n'));
    await settle([a]);
    await a.adapter.write('n.md', text('v2\n'));
    await settle([a]);
    await a.adapter.write('n.md', text('unsynced\n'));
    const hist = await fileHistory(a.api, ring, 'n.md');
    await expect(restore(a.api, ring, a.adapter, a.state, hist[1]!)).rejects.toBeInstanceOf(UnsyncedChangesError);
    expect(files(a.adapter)).toEqual({ 'n.md': 'unsynced\n' });
  });

  it('refuses to restore a deleted file over an unsynced local file at its path', async () => {
    const user = await newUser(srv);
    const a = await makeClient(srv, user, { name: 'A', vault: 'create' });
    const b = await makeClient(srv, user, { name: 'B', vault: a.vaultId });
    const ring = await keyringFromStored((await a.state.getVault())!);
    await a.adapter.write('n.md', text('v1\n'));
    await settle([a, b]);
    await b.adapter.remove('n.md');
    await settle([a, b]);
    await a.adapter.write('n.md', text('written again, not synced\n'));
    const trash = await listTrash(a.api, ring);
    expect(trash.map((t) => t.meta?.path)).toEqual(['n.md']);
    await expect(restore(a.api, ring, a.adapter, a.state, trash[0]!)).rejects.toBeInstanceOf(UnsyncedChangesError);
    expect(files(a.adapter)).toEqual({ 'n.md': 'written again, not synced\n' });
  });

  it('refuses while a commit of the file is still waiting for its answer', async () => {
    const user = await newUser(srv);
    const a = await makeClient(srv, user, { name: 'A', vault: 'create' });
    const ring = await keyringFromStored((await a.state.getVault())!);
    await a.adapter.write('n.md', text('v1\n'));
    await settle([a]);
    await a.adapter.write('n.md', text('v2\n'));
    a.net.loseNextResponse('POST', '/commit');
    await a.engine.runCycle(); // v2 lands, the answer is lost: a pending commit stays
    expect(await a.state.allPending()).toHaveLength(1);
    const hist = await fileHistory(a.api, ring, 'n.md');
    await expect(restore(a.api, ring, a.adapter, a.state, hist[1]!)).rejects.toBeInstanceOf(UnsyncedChangesError);
    expect(files(a.adapter)).toEqual({ 'n.md': 'v2\n' });
  });

  it('restores over a synced local file, which then syncs as a new version', async () => {
    const user = await newUser(srv);
    const a = await makeClient(srv, user, { name: 'A', vault: 'create' });
    const b = await makeClient(srv, user, { name: 'B', vault: a.vaultId });
    const ring = await keyringFromStored((await a.state.getVault())!);
    await a.adapter.write('n.md', text('v1\n'));
    await settle([a, b]);
    await b.adapter.write('n.md', text('v2\n'));
    await settle([a, b]);
    const hist = await fileHistory(a.api, ring, 'n.md');
    await restore(a.api, ring, a.adapter, a.state, hist[1]!);
    await settle([a, b]);
    expect(files(a.adapter)).toEqual({ 'n.md': 'v1\n' });
    expect(files(b.adapter)).toEqual({ 'n.md': 'v1\n' });
    expect(await fileHistory(a.api, ring, 'n.md')).toHaveLength(3);
    expect([...a.events, ...b.events].some((e) => e.type === 'conflict')).toBe(false);
  });
});
