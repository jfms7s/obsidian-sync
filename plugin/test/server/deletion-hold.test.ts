// A large local deletion (owner decision 2026-10-09): more than 50 files and
// more than 20% of the synced files deleted at once are held on this device
// until the user deletes them everywhere or restores them here.
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { heldDeletions, releaseHeldDeletions, restoreHeldDeletions } from '../../src/sync/deletion-hold';
import { makeClient, settle, type SimClient } from '../helpers/client';
import { files, newUser, text } from '../helpers/fixture';
import { startServer, type TestServer } from '../helpers/server';

let srv: TestServer;
beforeAll(async () => {
  srv = await startServer(inject('obsyncBin'));
});
afterAll(() => srv?.stop());

const name = (i: number) => `notes/n${String(i).padStart(3, '0')}.md`;

/** A and B with n synced notes. */
async function syncedPair(n: number): Promise<{ a: SimClient; b: SimClient }> {
  const user = await newUser(srv);
  const a = await makeClient(srv, user, { name: 'A', vault: 'create' });
  const b = await makeClient(srv, user, { name: 'B', vault: a.vaultId });
  for (let i = 0; i < n; i++) await a.adapter.write(name(i), text(`note ${i}\n`));
  await settle([a, b]);
  expect(Object.keys(files(b.adapter))).toHaveLength(n);
  return { a, b };
}

const heldNotices = (c: SimClient) => c.events.filter((e) => e.type === 'notice' && e.code === 'DELETIONS_HELD');

describe('a large local deletion', () => {
  it('is held: nothing is deleted on the server or the other device, and the device is told once', async () => {
    const { a, b } = await syncedPair(200);
    for (let i = 0; i < 200; i++) await a.adapter.remove(name(i));
    await a.engine.runCycle();
    await a.engine.runCycle();
    await settle([b]);
    expect(Object.keys(files(b.adapter))).toHaveLength(200);
    expect(await heldDeletions(a.state)).toHaveLength(200);
    expect(heldNotices(a)).toEqual([expect.objectContaining({ persistent: true, message: expect.stringContaining('200 files') })]);
    expect(a.engine.status).toBe('synced');
    await a.engine.stop();
    await b.engine.stop();
  }, 60_000);

  it('stays held across a restart, and reconcile does not queue it again', async () => {
    const { a, b } = await syncedPair(200);
    for (let i = 0; i < 200; i++) a.adapter.removeSilently(name(i)); // deleted while Obsidian was closed
    await a.restart(); // the restart reconciles and finds them gone
    await a.engine.runCycle();
    expect(await heldDeletions(a.state)).toHaveLength(200);
    await a.restart();
    await a.engine.runCycle();
    a.engine.requestReconcile();
    await a.engine.runCycle();
    expect(await heldDeletions(a.state)).toHaveLength(200);
    expect(await a.state.dirtyEntries()).toEqual([]);
    await settle([b]);
    expect(Object.keys(files(b.adapter))).toHaveLength(200);
    await a.engine.stop();
    await b.engine.stop();
  }, 60_000);

  it('is deleted everywhere once the user says so', async () => {
    const { a, b } = await syncedPair(200);
    for (let i = 0; i < 200; i++) await a.adapter.remove(name(i));
    await a.engine.runCycle();
    expect(await releaseHeldDeletions(a.state)).toBe(200);
    await settle([a, b]);
    expect(files(b.adapter)).toEqual({});
    expect(await heldDeletions(a.state)).toEqual([]);
    await a.engine.stop();
    await b.engine.stop();
  }, 60_000);

  it('is restored here once the user says so, and the other device keeps its files', async () => {
    const { a, b } = await syncedPair(200);
    for (let i = 0; i < 200; i++) await a.adapter.remove(name(i));
    await a.engine.runCycle();
    expect(await restoreHeldDeletions(a.state)).toBe(200);
    a.engine.requestReconcile();
    await settle([a, b]);
    expect(Object.keys(files(a.adapter))).toHaveLength(200);
    expect(files(a.adapter)[name(7)]).toBe('note 7\n');
    expect(Object.keys(files(b.adapter))).toHaveLength(200);
    expect(await heldDeletions(a.state)).toEqual([]);
    await a.engine.stop();
    await b.engine.stop();
  }, 60_000);

  it('lets a held file that comes back sync normally', async () => {
    const { a, b } = await syncedPair(200);
    for (let i = 0; i < 200; i++) await a.adapter.remove(name(i));
    await a.engine.runCycle();
    await a.adapter.write(name(3), text('back again\n'));
    await a.engine.runCycle();
    expect(await heldDeletions(a.state)).toHaveLength(199);
    await settle([b]);
    expect(files(b.adapter)[name(3)]).toBe('back again\n');
    await a.engine.stop();
    await b.engine.stop();
  }, 60_000);
});

describe('smaller deletions', () => {
  it('sync without asking at 50 files', async () => {
    const { a, b } = await syncedPair(200);
    for (let i = 0; i < 50; i++) await a.adapter.remove(name(i));
    await settle([a, b]);
    expect(Object.keys(files(b.adapter))).toHaveLength(150);
    expect(heldNotices(a)).toEqual([]);
    await a.engine.stop();
    await b.engine.stop();
  }, 60_000);

  it('sync without asking at 20% or less of the synced files', async () => {
    const { a, b } = await syncedPair(400);
    for (let i = 0; i < 80; i++) await a.adapter.remove(name(i)); // 80 files, exactly 20%
    await settle([a, b]);
    expect(Object.keys(files(b.adapter))).toHaveLength(320);
    expect(heldNotices(a)).toEqual([]);
    await a.engine.stop();
    await b.engine.stop();
  }, 120_000);

  it('a folder renamed on this device is not a deletion', async () => {
    const { a, b } = await syncedPair(200);
    for (let i = 0; i < 200; i++) await a.adapter.rename(name(i), name(i).replace('notes/', 'archive/'));
    await settle([a, b]);
    expect(Object.keys(files(b.adapter)).every((p) => p.startsWith('archive/'))).toBe(true);
    expect(heldNotices(a)).toEqual([]);
    await a.engine.stop();
    await b.engine.stop();
  }, 60_000);
});
