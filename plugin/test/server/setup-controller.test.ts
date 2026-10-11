// The setup controller behind the settings tab, against the real server.
import { IDBFactory } from 'fake-indexeddb';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import { KeysAlreadySetUpError, PassphraseIsPasswordError, WeakPassphraseError } from '../../src/services/account';
import { ShellController } from '../../src/shell/controller';
import { createEngineLock } from '../../src/shell/engine-lock';
import { SetupController } from '../../src/shell/setup-controller';
import { LocalState } from '../../src/state/store';
import { MemoryAdapter } from '../../src/vault/memory';
import { makeClient, settle } from '../helpers/client';
import { files, newDevice, newUser, PASSPHRASE as FIXTURE_PASSPHRASE, text, type User } from '../helpers/fixture';
import { Net } from '../helpers/net';
import { startServer, type TestServer } from '../helpers/server';

let srv: TestServer;
beforeAll(async () => {
  srv = await startServer(inject('obsyncBin'));
});
afterAll(() => srv?.stop());

const PASSPHRASE = 'maple rocket tundra otter';

interface TestDevice {
  setup: SetupController;
  shell: ShellController;
  state: LocalState;
  adapter: MemoryAdapter;
  net: Net;
  /** The same device after a plugin reload: new controllers on the same state, files and lock. */
  reload(): TestDevice;
}

async function device(name: string): Promise<TestDevice> {
  const net = new Net();
  const state = await LocalState.open(new IDBFactory(), `setup-${name}-${Math.random()}`);
  const adapter = new MemoryAdapter();
  const registry = new Map<string, Promise<void>>();
  const build = (): TestDevice => {
    const shell = new ShellController({
      state, adapter, configDir: '.obsidian', fetch: net.fetch, webSocket: null, autoRun: false,
      lock: createEngineLock(`setup-${name}`, { locks: null, registry }),
    });
    return { setup: new SetupController({ state, fetch: net.fetch, shell }), shell, state, adapter, net, reload: build };
  };
  return build();
}

const commits = (net: Net) => net.log.filter((r) => r.method === 'POST' && r.path.endsWith('/commit')).length;

const signIn = (setup: SetupController, user: User, name: string) => setup.login(srv.url, user.username, user.password, name, 'test');

describe('SetupController', () => {
  it('takes a first device from sign-in to a running engine', async () => {
    const user = await newUser(srv);
    const { setup, shell } = await device('first');
    expect(await setup.step()).toEqual({ kind: 'login' });
    await signIn(setup, user, 'Laptop');
    expect(await setup.step()).toEqual({ kind: 'setup-keys', reupload: false });
    const keys = await setup.setupKeys(PASSPHRASE, PASSPHRASE);
    expect('recoveryWords' in keys && keys.recoveryWords.split(' ')).toHaveLength(24);
    expect((await setup.step()).kind).toBe('confirm-recovery');
    await setup.acknowledgeRecoveryWords();
    expect(await setup.step()).toEqual({ kind: 'choose-vault' });
    expect(await setup.remoteVaults()).toEqual({ locked: false, vaults: [] });
    await setup.createVault('  Notes  ');
    expect(await setup.step()).toEqual({ kind: 'confirm-ignores' });
    expect(shell.engine).toBeNull();
    expect(await setup.confirmIgnores([])).toEqual({ ok: true });
    expect(shell.engine).not.toBeNull();
    expect(shell.setupNeeded).toBe(false);
    expect(await setup.step()).toEqual({ kind: 'ready' });
    expect(await setup.vaultName()).toBe('Notes');
    expect((await setup.devices()).find((d) => d.current)?.name).toBe('Laptop');
    await shell.stop();
  }, 60_000);

  it('checks the passphrase before it sets up any keys', async () => {
    const user = await newUser(srv);
    const { setup, state } = await device('checks');
    await signIn(setup, user, 'Laptop');
    await expect(setup.setupKeys(user.password, user.password)).rejects.toBeInstanceOf(PassphraseIsPasswordError);
    await expect(setup.setupKeys('short', 'short')).rejects.toBeInstanceOf(WeakPassphraseError);
    await expect(setup.setupKeys(PASSPHRASE, `${PASSPHRASE}!`)).rejects.toThrow('The two passphrases are not the same.');
    expect(await state.getPendingKeySetup()).toBeUndefined();
  });

  it('says the keys were already set up when another device finished first, then unlocks', async () => {
    const user = await newUser(srv);
    const a = await device('a');
    const b = await device('b');
    await signIn(a.setup, user, 'A');
    await signIn(b.setup, user, 'B');
    expect(await b.setup.step()).toEqual({ kind: 'setup-keys', reupload: false });
    await a.setup.setupKeys(PASSPHRASE, PASSPHRASE);
    const result = await b.setup.setupKeys('another strong passphrase here', 'another strong passphrase here');
    expect(result).toEqual({ alreadySetUp: expect.any(KeysAlreadySetUpError) });
    expect(await b.setup.step()).toEqual({ kind: 'unlock' });
    expect(await b.setup.remoteVaults()).toEqual({ locked: true });
    await b.setup.unlockWithPassphrase(PASSPHRASE);
    expect(await b.setup.step()).toEqual({ kind: 'choose-vault' });
  }, 60_000);

  it('switches to a vault, and reports when sync then cannot start', async () => {
    const user = await newUser(srv);
    const first = await device('owner');
    await signIn(first.setup, user, 'Laptop');
    await first.setup.setupKeys(PASSPHRASE, PASSPHRASE);
    await first.setup.acknowledgeRecoveryWords();
    await first.setup.createVault('Shared');
    expect(await first.setup.confirmIgnores([])).toEqual({ ok: true });
    await first.shell.stop();

    const second = await device('joiner');
    await signIn(second.setup, user, 'Phone');
    await second.setup.unlockWithPassphrase(PASSPHRASE);
    const listed = await second.setup.remoteVaults();
    if (listed.locked) throw new Error('expected the vault list');
    expect(listed.vaults.map((v) => v.name)).toEqual(['Shared']);
    await second.setup.useVault(listed.vaults[0]!.vaultId);
    expect(await second.setup.vaultName()).toBe('Shared');
    expect(await second.setup.step()).toEqual({ kind: 'confirm-ignores' });
    const start = vi.spyOn(second.shell, 'start').mockResolvedValue({ ok: false, reason: 'locked' });
    expect(await second.setup.confirmIgnores([])).toEqual({ ok: false, reason: 'locked' });
    expect(start).toHaveBeenCalledWith({ byUser: true });
    start.mockRestore();
    expect(await second.setup.confirmIgnores([])).toEqual({ ok: true });
    expect(second.shell.engine).not.toBeNull();
    await second.shell.stop();
  }, 60_000);

  it('refuses an empty vault name without stopping the sync', async () => {
    const { setup, shell } = await device('empty');
    const stop = vi.spyOn(shell, 'stopForGood');
    await expect(setup.createVault('   ')).rejects.toThrow('Give the vault a name.');
    expect(stop).not.toHaveBeenCalled();
  });
});

describe('the ignore step before the first sync', () => {
  it('uploads nothing until the step is confirmed, also across a reload, and applies its rules to the first upload', async () => {
    const user = await newUser(srv);
    const dev = await device('ignore-step');
    for (let i = 0; i < 20; i++) await dev.adapter.write(`.venv/lib/m${i}.py`, text(`m${i}\n`));
    await dev.adapter.write('note.md', text('note\n'));
    await signIn(dev.setup, user, 'Laptop');
    await dev.setup.setupKeys(FIXTURE_PASSPHRASE, FIXTURE_PASSPHRASE);
    await dev.setup.acknowledgeRecoveryWords();
    await dev.setup.createVault('Big');
    expect(await dev.setup.step()).toEqual({ kind: 'confirm-ignores' });
    expect(dev.shell.engine).toBeNull();

    // A reload before confirming: the plugin's start at load does not sync, the step shows again.
    const reloaded = dev.reload();
    expect(await reloaded.shell.start()).toEqual({ ok: false, reason: 'ignores-unconfirmed' });
    expect(reloaded.shell.setupNeeded).toBe(true);
    expect(reloaded.shell.engine).toBeNull();
    expect(await reloaded.setup.step()).toEqual({ kind: 'confirm-ignores' });
    expect(commits(dev.net)).toBe(0);

    expect(await reloaded.setup.confirmIgnores(['.venv/'])).toEqual({ ok: true });
    expect(await reloaded.setup.step()).toEqual({ kind: 'ready' });
    expect(await reloaded.shell.ignoreGlobs()).toEqual(['.venv/']);
    await reloaded.shell.engine!.runCycle();
    expect(commits(dev.net)).toBeGreaterThan(0);
    const vault = (await dev.state.getVault())!;
    const other = await makeClient(srv, user, { name: 'Phone', vault: vault.vaultId });
    await settle([other]);
    expect(files(other.adapter)).toEqual({ 'note.md': 'note\n' });
    await reloaded.shell.stop();
  }, 60_000);

  it('refuses invalid rules on the step and keeps the vault waiting', async () => {
    const user = await newUser(srv);
    const dev = await device('ignore-invalid');
    await signIn(dev.setup, user, 'Laptop');
    await dev.setup.setupKeys(FIXTURE_PASSPHRASE, FIXTURE_PASSPHRASE);
    await dev.setup.acknowledgeRecoveryWords();
    await dev.setup.createVault('V');
    await expect(dev.setup.confirmIgnores(['!negated'])).rejects.toThrow();
    expect(await dev.setup.step()).toEqual({ kind: 'confirm-ignores' });
    expect(dev.shell.engine).toBeNull();
  }, 60_000);

  it('does not stop a device whose vault was chosen before the step existed', async () => {
    const user = await newUser(srv);
    const dev = await newDevice(srv, user, { name: 'Upgraded', vault: 'create' }); // stored vault without the flag
    const shell = new ShellController({
      state: dev.state, adapter: dev.adapter, configDir: '.obsidian', fetch: dev.net.fetch, webSocket: null, autoRun: false,
      lock: createEngineLock('upgraded', { locks: null, registry: new Map() }),
    });
    const setup = new SetupController({ state: dev.state, fetch: dev.net.fetch, shell });
    await setup.acknowledgeRecoveryWords();
    expect(await setup.step()).toEqual({ kind: 'ready' });
    expect(await shell.start()).toEqual({ ok: true });
    await shell.stop();
  });
});

describe('ShellController.setupNeeded', () => {
  it('is true after a start that found the device not set up, and false once an engine runs', async () => {
    const user = await newUser(srv);
    const { setup, shell } = await device('needed');
    expect(shell.setupNeeded).toBe(false);
    expect(await shell.start()).toEqual({ ok: false, reason: 'not-logged-in' });
    expect(shell.setupNeeded).toBe(true);
    await signIn(setup, user, 'Laptop');
    await setup.setupKeys(PASSPHRASE, PASSPHRASE);
    await setup.acknowledgeRecoveryWords();
    await setup.createVault('V');
    await setup.confirmIgnores([]);
    expect(shell.setupNeeded).toBe(false);
    await shell.stop();
    expect(shell.setupNeeded).toBe(false);
  }, 60_000);
});
