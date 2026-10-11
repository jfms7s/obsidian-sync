// The shell's controller and history controller, against the real server.
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import { InvalidIgnorePatternError } from '../../src/vault/ignore';
import { createEngineLock } from '../../src/shell/engine-lock';
import { HistoryController } from '../../src/shell/history-controller';
import { ShellController, type ShellOptions } from '../../src/shell/controller';
import { SyncEngine } from '../../src/sync/engine';
import type { EngineEvent } from '../../src/sync/events';
import type { EngineLock } from '../../src/shell/engine-lock';
import type { LocalState } from '../../src/state/store';
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

/** Whether the lock can be taken at once (and gives it straight back). */
async function lockIsFree(lock: EngineLock): Promise<boolean> {
  const release = await Promise.race([lock.acquire(), flush().then(() => null)]);
  release?.();
  return release !== null;
}

/** Makes engine.stop() wait until the returned function is called. */
function slowStop(engine: SyncEngine): () => void {
  let open!: () => void;
  const gate = new Promise<void>((r) => (open = r));
  const real = engine.stop.bind(engine);
  engine.stop = async () => {
    await gate;
    await real();
  };
  return open;
}

/**
 * A state whose first read of key waits until the returned function is
 * called, after the read: a start in progress (holding the lock) has
 * already taken the value it read.
 */
function gatedRead(state: LocalState, key: 'getSession' | 'ignoreGlobs'): { state: LocalState; open: () => void } {
  let open!: () => void;
  const gate = new Promise<void>((r) => (open = r));
  let first = true;
  const proxy = new Proxy(state, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target) as unknown;
      if (typeof value !== 'function') return value;
      const fn = value as (...args: unknown[]) => unknown;
      const gated = key === 'getSession' ? prop === 'getSession' : prop === 'getSetting';
      if (!gated) return fn.bind(target);
      return async (...args: unknown[]) => {
        const result = await fn.apply(target, args);
        if (first && (key === 'getSession' || args[0] === 'ignoreGlobs')) {
          first = false;
          await gate;
        }
        return result;
      };
    },
  });
  return { state: proxy, open };
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

  it('keeps the engine when it is started again while a stop waits for the start in progress', async () => {
    const user = await newUser(srv);
    const dev = await newDevice(srv, user, { name: 'Laptop', vault: 'create' });
    let open!: () => void;
    const opened = new Promise<void>((r) => (open = r));
    // Holds the start inside openSyncSession (after it took the lock) until the gate opens.
    const state = new Proxy(dev.state, {
      get(target, key) {
        const value = Reflect.get(target, key, target) as unknown;
        if (typeof value !== 'function') return value;
        const fn = value as (...args: unknown[]) => unknown;
        if (key === 'getSession') return async (...args: unknown[]) => { await opened; return fn.apply(target, args); };
        return fn.bind(target);
      },
    });
    const c = controllerFor(dev, { state });
    const first = c.start();
    await flush();
    const stopping = c.stop();
    const again = c.start();
    open();
    await stopping;
    expect(await first).toEqual({ ok: true });
    expect(await again).toEqual({ ok: true });
    expect(c.engine).not.toBeNull();
    await c.stop();
    expect(c.engine).toBeNull();
  });

  it('returns from a second concurrent stop only once the engine has stopped and the lock is free', async () => {
    const user = await newUser(srv);
    const dev = await newDevice(srv, user, { name: 'Laptop', vault: 'create' });
    const lock = createEngineLock('vault', { locks: null, registry: new Map() });
    const c = controllerFor(dev, { lock });
    await c.start();
    const engine = c.engine!;
    const finishStop = slowStop(engine);
    const first = c.stop();
    let secondDone = false;
    const second = c.stop().then(() => {
      secondDone = true;
    });
    await flush();
    expect(secondDone).toBe(false);
    finishStop();
    await second;
    expect(engine.status).toBe('stopped');
    expect(await lockIsFree(lock)).toBe(true);
    await first;
  });

  it('leaves no engine running and the lock free after stop, start, stop', async () => {
    const user = await newUser(srv);
    const dev = await newDevice(srv, user, { name: 'Laptop', vault: 'create' });
    const lock = createEngineLock('vault', { locks: null, registry: new Map() });
    const c = controllerFor(dev, { lock });
    await c.start();
    const engine = c.engine!;
    const finishStop = slowStop(engine);
    const stops = [c.stop()];
    const again = c.start();
    stops.push(c.stop());
    setTimeout(finishStop, 30);
    await stops[1];
    expect(engine.status).toBe('stopped');
    expect(c.engine).toBeNull();
    expect(await lockIsFree(lock)).toBe(true);
    expect(await again).toEqual({ ok: false, reason: 'stopped' });
    await Promise.all(stops);
    expect(c.engine).toBeNull();
  });

  it('runs no engine after a logout during a start, even when something asks to start again meanwhile', async () => {
    const user = await newUser(srv);
    const dev = await newDevice(srv, user, { name: 'Laptop', vault: 'create' });
    const { state, open } = gatedRead(dev.state, 'getSession');
    const lock = createEngineLock('vault', { locks: null, registry: new Map() });
    const c = controllerFor(dev, { state, lock });
    const first = c.start();
    await flush();
    const out = c.logout();
    const automatic = c.start(); // e.g. the plugin's start when the layout is ready
    open();
    await out;
    expect(c.engine).toBeNull();
    expect(await dev.state.getSession()).toBeUndefined();
    await first;
    expect(await automatic).toEqual({ ok: false, reason: 'stopped' });
    expect(c.engine).toBeNull();
    expect(await lockIsFree(lock)).toBe(true);
  });

  it('applies ignore rules saved while a start is in progress', async () => {
    const user = await newUser(srv);
    const dev = await newDevice(srv, user, { name: 'Laptop', vault: 'create' });
    const other = await makeClient(srv, user, { name: 'Phone', vault: dev.vaultId });
    const { state, open } = gatedRead(dev.state, 'ignoreGlobs');
    const c = controllerFor(dev, { state });
    const starting = c.start();
    await flush(); // the start has read the old rules and holds the lock
    const saving = c.setIgnoreGlobs(['Scratch/']);
    await flush();
    open();
    await saving;
    expect(await starting).toEqual({ ok: true });
    await dev.adapter.write('Scratch/s.md', text('scratch\n'));
    await dev.adapter.write('keep.md', text('keep\n'));
    await c.engine!.runCycle();
    await settle([other]);
    expect(files(other.adapter)).toEqual({ 'keep.md': 'keep\n' });
    await c.stop();
  });

  it('detaches the engine and gives the lock back when the engine fails to start', async () => {
    const user = await newUser(srv);
    const dev = await newDevice(srv, user, { name: 'Laptop', vault: 'create' });
    const lock = createEngineLock('vault', { locks: null, registry: new Map() });
    const c = controllerFor(dev, { lock });
    const events: EngineEvent[] = [];
    c.on((e) => events.push(e));
    let failed: SyncEngine | null = null;
    const start = vi.spyOn(SyncEngine.prototype, 'start').mockImplementationOnce(async function (this: SyncEngine) {
      failed = this;
      throw new Error('boom');
    });
    try {
      await expect(c.start()).rejects.toThrow('boom');
    } finally {
      start.mockRestore();
    }
    expect(c.engine).toBeNull();
    expect(await lockIsFree(lock)).toBe(true);
    (failed! as unknown as { emit(e: EngineEvent): void }).emit({ type: 'status', status: 'synced' });
    expect(events).toEqual([]);
    expect(await c.start()).toEqual({ ok: true }); // a later start works
    await c.stop();
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
