// The shell's controller and history controller, against the real server.
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { InvalidIgnorePatternError } from '../../src/vault/ignore';
import { createEngineLock } from '../../src/shell/engine-lock';
import { HistoryController } from '../../src/shell/history-controller';
import { ShellController, type ShellOptions } from '../../src/shell/controller';
import type { EngineEvent } from '../../src/sync/events';
import { makeClient, settle } from '../helpers/client';
import { files, newDevice, newUser, text, type Device } from '../helpers/fixture';
import { startServer, type TestServer } from '../helpers/server';

let srv: TestServer;
beforeAll(async () => {
  srv = await startServer(inject('obsyncBin'));
});
afterAll(() => srv?.stop());

const flush = () => new Promise<void>((r) => setTimeout(r, 20));

function controllerFor(dev: Device, extra: Partial<ShellOptions> = {}): ShellController {
  return new ShellController({
    state: dev.state, adapter: dev.adapter, configDir: '.obsidian', fetch: dev.net.fetch, webSocket: null, autoRun: false,
    lock: createEngineLock('test-vault', { locks: null, registry: new Map() }), clock: dev.clock, random: dev.random, ...extra,
  });
}

describe('ShellController', () => {
  it('starts the engine of a set-up device and syncs it with another device', async () => {
    const user = await newUser(srv);
    const dev = await newDevice(srv, user, { name: 'Laptop', vault: 'create' });
    const other = await makeClient(srv, user, { name: 'Phone', vault: dev.vaultId });
    const c = controllerFor(dev);
    const events: EngineEvent[] = [];
    c.on((e) => events.push(e));
    expect(c.status).toBe('stopped');
    expect(await c.start()).toEqual({ ok: true });
    expect(await c.start()).toEqual({ ok: true }); // idempotent
    await dev.adapter.write('Notes/a.md', text('from laptop\n'));
    await c.engine!.runCycle();
    await settle([other]);
    expect(files(other.adapter)).toEqual({ 'Notes/a.md': 'from laptop\n' });
    expect(c.status).toBe('synced');
    expect(events).toContainEqual({ type: 'status', status: 'synced' });
    await c.stop();
    expect(c.status).toBe('stopped');
  });

  it('says what is missing when the device is not set up, and holds nothing afterwards', async () => {
    const user = await newUser(srv);
    const dev = await newDevice(srv, user, { name: 'Laptop', vault: 'create' });
    await dev.state.clearSession();
    const lock = createEngineLock('shared', { locks: null, registry: new Map() });
    const c = controllerFor(dev, { lock });
    expect(await c.start()).toEqual({ ok: false, reason: 'not-logged-in' });
    // The lock was given back: another instance can take it at once.
    const release = await Promise.race([lock.acquire(), flush().then(() => null)]);
    expect(release).not.toBeNull();
    release?.();
  });

  it('waits for the previous instance after a plugin reload, so two engines never run on one vault', async () => {
    const user = await newUser(srv);
    const dev = await newDevice(srv, user, { name: 'Laptop', vault: 'create' });
    const registry = new Map<string, Promise<void>>();
    const old = controllerFor(dev, { lock: createEngineLock('vault', { locks: null, registry }) });
    const fresh = controllerFor(dev, { lock: createEngineLock('vault', { locks: null, registry }) });
    await old.start();
    let started = false;
    const starting = fresh.start().then((r) => {
      started = true;
      return r;
    });
    await flush();
    expect(started).toBe(false);
    expect(fresh.engine).toBeNull();
    void old.stop(); // Obsidian does not wait for onunload
    expect(await starting).toEqual({ ok: true });
    expect(old.engine).toBeNull();
    expect(fresh.engine).not.toBeNull();
    await fresh.stop();
  });

  it('never starts an engine when it is stopped while waiting for the lock', async () => {
    const user = await newUser(srv);
    const dev = await newDevice(srv, user, { name: 'Laptop', vault: 'create' });
    const registry = new Map<string, Promise<void>>();
    const holder = createEngineLock('vault', { locks: null, registry });
    const release = await holder.acquire();
    const c = controllerFor(dev, { lock: createEngineLock('vault', { locks: null, registry }) });
    const starting = c.start();
    await flush();
    await c.stop();
    release();
    expect(await starting).toEqual({ ok: false, reason: 'stopped' });
    expect(c.engine).toBeNull();
  });

  it('does not sync the configuration folder, whatever it is called, and applies the user\'s ignore rules', async () => {
    const user = await newUser(srv);
    const dev = await newDevice(srv, user, { name: 'Laptop', vault: 'create' });
    const other = await makeClient(srv, user, { name: 'Phone', vault: dev.vaultId });
    const c = controllerFor(dev, { configDir: '.obsidian-mobile' });
    await c.start();
    await dev.adapter.write('.obsidian-mobile/app.json', text('{}'));
    await dev.adapter.write('Scratch/s.md', text('scratch\n'));
    await dev.adapter.write('keep.md', text('keep\n'));
    await c.setIgnoreGlobs(['Scratch/']); // restarts the engine with the new rules
    await c.engine!.runCycle();
    await settle([other]);
    expect(files(other.adapter)).toEqual({ 'keep.md': 'keep\n' });
    expect(await c.ignoreGlobs()).toEqual(['Scratch/']);
    await expect(c.setIgnoreGlobs(['!nope'])).rejects.toBeInstanceOf(InvalidIgnorePatternError);
    expect(await c.ignoreGlobs()).toEqual(['Scratch/']);
    await c.stop();
  });

  it('stops syncing and forgets the account on logout', async () => {
    const user = await newUser(srv);
    const dev = await newDevice(srv, user, { name: 'Laptop', vault: 'create' });
    const c = controllerFor(dev);
    await c.start();
    await c.logout();
    expect(c.engine).toBeNull();
    expect(await dev.state.getSession()).toBeUndefined();
    expect(await c.start()).toEqual({ ok: false, reason: 'not-logged-in' });
  });
});

describe('HistoryController', () => {
  async function started() {
    const user = await newUser(srv);
    const dev = await newDevice(srv, user, { name: 'Laptop', vault: 'create' });
    const c = controllerFor(dev);
    await c.start();
    return { dev, c, history: c.history()! };
  }

  it('compares a version with the file as it is now, restores it, and finds deleted files in the trash', async () => {
    const { dev, c, history } = await started();
    await dev.adapter.write('n.md', text('one\ntwo\n'));
    await c.engine!.runCycle();
    await dev.adapter.write('n.md', text('one\nTWO\nthree\n'));
    await c.engine!.runCycle();
    const versions = await history.versions('n.md');
    expect(versions).toHaveLength(2);
    const older = versions[1]!;
    expect(await history.compare(older)).toEqual({
      kind: 'text',
      lines: [{ kind: 'same', text: 'one' }, { kind: 'del', text: 'two' }, { kind: 'add', text: 'TWO' }, { kind: 'add', text: 'three' }],
    });
    expect(await history.restore(older)).toBe('n.md');
    expect(files(dev.adapter)).toEqual({ 'n.md': 'one\ntwo\n' });

    await c.engine!.runCycle();
    await dev.adapter.remove('n.md');
    await c.engine!.runCycle();
    const trash = await history.trash();
    expect(trash.map((t) => t.path)).toEqual(['n.md']);
    await history.restore(trash[0]!.entry);
    expect(files(dev.adapter)).toEqual({ 'n.md': 'one\ntwo\n' });
    await c.stop();
  });

  it('says a binary file cannot be compared, and a version too long to compare too', async () => {
    const { dev, c, history } = await started();
    await dev.adapter.write('img.png', new Uint8Array([1, 2, 3, 255, 0]));
    await c.engine!.runCycle();
    await dev.adapter.write('img.png', new Uint8Array([9, 8, 7, 255, 0]));
    await c.engine!.runCycle();
    const [, older] = await history.versions('img.png');
    expect(await history.compare(older!)).toEqual({ kind: 'binary' });
    await dev.adapter.write('long.md', text('x\n'.repeat(6000)));
    await c.engine!.runCycle();
    await dev.adapter.write('long.md', text('y\n'.repeat(6000)));
    await c.engine!.runCycle();
    const [, olderLong] = await history.versions('long.md');
    expect(await history.compare(olderLong!)).toEqual({ kind: 'text', lines: null });
    await c.stop();
  });
});
