// obsync-cli restarts from its state snapshot (spec D3): an unchanged
// folder costs no commits, and a crash that loses the last cycle's state
// replays it without a conflict copy or a duplicate version.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest';
import { PersistentState } from '../../cli/state';
import { fileIdFor } from '../../src/crypto/objects';
import { openSyncSession } from '../../src/services/session';
import type { SyncEngine } from '../../src/sync/engine';
import type { EngineEvent } from '../../src/sync/events';
import { CONFLICT_COPY_PATTERN } from '../../src/util/path';
import { makeClient, settle, type SimClient } from '../helpers/client';
import { files, newUser, text } from '../helpers/fixture';
import { startServer, type TestServer } from '../helpers/server';

let srv: TestServer;
beforeAll(async () => {
  srv = await startServer(inject('obsyncBin'));
});
afterAll(() => srv?.stop());

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

/** A desktop whose state lives in a snapshot directory, and a phone on the same vault. */
async function desktopAndPhone(): Promise<{ desktop: SimClient; phone: SimClient; ps: PersistentState; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'obsync-cli-state-'));
  dirs.push(dir);
  const ps = await PersistentState.open(dir);
  const user = await newUser(srv);
  const desktop = await makeClient(srv, user, { name: 'Desktop', vault: 'create', state: ps.state });
  const phone = await makeClient(srv, user, { name: 'Phone', vault: desktop.vaultId });
  return { desktop, phone, ps, dir };
}

/** What obsync-cli does on start: load the snapshot and open a session over it, with the same folder (adapter) and network. */
async function restart(desktop: SimClient, dir: string): Promise<{ ps: PersistentState; engine: SyncEngine; events: EngineEvent[] }> {
  const ps = await PersistentState.open(dir);
  const s = await openSyncSession({ state: ps.state, adapter: desktop.adapter, fetch: desktop.net.fetch, clock: desktop.clock, random: desktop.random, configDir: '.obsidian', webSocket: null, autoRun: false });
  if (!s.ok) throw new Error(`no session after restart: ${s.reason}`);
  const events: EngineEvent[] = [];
  s.engine.on((e) => events.push(e));
  await s.engine.start();
  return { ps, engine: s.engine, events };
}

async function versionsOf(c: SimClient, path: string): Promise<number> {
  return (await c.api.history(c.vaultId, await fileIdFor(c.ring.namingKey, path))).length;
}

function conflictCopies(c: SimClient): string[] {
  return Object.keys(files(c.adapter)).filter((p) => CONFLICT_COPY_PATTERN.test(p));
}

describe('obsync-cli state across restarts', () => {
  it('commits nothing for unchanged files after a restart, and still syncs both ways', async () => {
    const { desktop, phone, ps, dir } = await desktopAndPhone();
    for (const n of ['one', 'two', 'three']) await desktop.adapter.write(`${n}.md`, text(`${n}\n`));
    await settle([desktop, phone]);
    await ps.save();
    await desktop.engine.stop();
    await ps.close();

    const commits = desktop.net.count('POST', '/commit');
    const after = await restart(desktop, dir);
    await after.engine.runCycle(); // the reconcile every start begins with
    await after.engine.runCycle();
    expect(desktop.net.count('POST', '/commit')).toBe(commits);
    expect(await after.ps.state.dirtyEntries()).toEqual([]);

    await phone.adapter.write('two.md', text('two from the phone\n'));
    await phone.engine.runCycle();
    await after.engine.runCycle();
    expect(files(desktop.adapter)['two.md']).toBe('two from the phone\n');
    await desktop.adapter.write('one.md', text('one, edited after the restart\n'));
    await after.engine.runCycle();
    await phone.engine.runCycle();
    expect(files(phone.adapter)['one.md']).toBe('one, edited after the restart\n');
    await after.engine.stop();
    await after.ps.close();
  });

  it('resends a commit whose response was lost before the crash, landing it once', async () => {
    const { desktop, phone, ps, dir } = await desktopAndPhone();
    await desktop.adapter.write('note.md', text('one\n'));
    desktop.net.loseNextResponse('POST', '/commit');
    await desktop.engine.runCycle(); // lands; the response is lost and the commit stays pending
    expect(await ps.state.allPending()).toHaveLength(1);
    await ps.save();
    await desktop.engine.stop();
    await ps.close();

    const after = await restart(desktop, dir);
    await after.engine.runCycle();
    await after.engine.runCycle();
    await phone.engine.runCycle();
    expect(await after.ps.state.allPending()).toEqual([]);
    expect(await versionsOf(desktop, 'note.md')).toBe(1);
    expect(files(phone.adapter)).toEqual({ 'note.md': 'one\n' });
    expect(conflictCopies(desktop)).toEqual([]);
    await after.engine.stop();
    await after.ps.close();
  });

  it('replays a cycle whose state was lost (killed after the commit, before the snapshot) without a conflict copy or a duplicate version', async () => {
    const { desktop, phone, ps, dir } = await desktopAndPhone();
    await desktop.adapter.write('note.md', text('one\n'));
    await settle([desktop, phone]);
    await ps.save(); // the last snapshot before the crash
    await desktop.adapter.write('note.md', text('one\ntwo\n'));
    await phone.adapter.write('other.md', text('from the phone\n'));
    await phone.engine.runCycle();
    await desktop.engine.runCycle(); // pulls other.md, commits note.md: none of it is in the snapshot
    expect(await versionsOf(desktop, 'note.md')).toBe(2);
    await desktop.engine.stop();
    await ps.close(); // killed: nothing saved

    const after = await restart(desktop, dir);
    for (let i = 0; i < 3; i++) await after.engine.runCycle();
    await phone.engine.runCycle();
    expect(await versionsOf(desktop, 'note.md')).toBe(2);
    expect(files(desktop.adapter)).toEqual({ 'note.md': 'one\ntwo\n', 'other.md': 'from the phone\n' });
    expect(files(phone.adapter)).toEqual(files(desktop.adapter));
    expect(conflictCopies(desktop)).toEqual([]);
    expect(after.events.some((e) => e.type === 'conflict')).toBe(false);
    expect(await after.ps.state.dirtyEntries()).toEqual([]);
    await after.engine.stop();
    await after.ps.close();
  });
});
