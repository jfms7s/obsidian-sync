// The setup controller behind the settings tab, against the real server.
import { IDBFactory } from 'fake-indexeddb';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import { KeysAlreadySetUpError, PassphraseIsPasswordError, WeakPassphraseError } from '../../src/services/account';
import { ShellController } from '../../src/shell/controller';
import { createEngineLock } from '../../src/shell/engine-lock';
import { SetupController } from '../../src/shell/setup-controller';
import { LocalState } from '../../src/state/store';
import { MemoryAdapter } from '../../src/vault/memory';
import { newUser, type User } from '../helpers/fixture';
import { Net } from '../helpers/net';
import { startServer, type TestServer } from '../helpers/server';

let srv: TestServer;
beforeAll(async () => {
  srv = await startServer(inject('obsyncBin'));
});
afterAll(() => srv?.stop());

const PASSPHRASE = 'maple rocket tundra otter';

async function device(name: string): Promise<{ setup: SetupController; shell: ShellController; state: LocalState }> {
  const net = new Net();
  const state = await LocalState.open(new IDBFactory(), `setup-${name}-${Math.random()}`);
  const shell = new ShellController({
    state, adapter: new MemoryAdapter(), configDir: '.obsidian', fetch: net.fetch, webSocket: null, autoRun: false,
    lock: createEngineLock(`setup-${name}`, { locks: null, registry: new Map() }),
  });
  return { setup: new SetupController({ state, fetch: net.fetch, shell }), shell, state };
}

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
    expect(await setup.createVault('  Notes  ')).toEqual({ ok: true });
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

  it('switches to a vault and reports when sync then cannot start', async () => {
    const user = await newUser(srv);
    const first = await device('owner');
    await signIn(first.setup, user, 'Laptop');
    await first.setup.setupKeys(PASSPHRASE, PASSPHRASE);
    await first.setup.acknowledgeRecoveryWords();
    expect(await first.setup.createVault('Shared')).toEqual({ ok: true });
    await first.shell.stop();

    const second = await device('joiner');
    await signIn(second.setup, user, 'Phone');
    await second.setup.unlockWithPassphrase(PASSPHRASE);
    const listed = await second.setup.remoteVaults();
    if (listed.locked) throw new Error('expected the vault list');
    expect(listed.vaults.map((v) => v.name)).toEqual(['Shared']);
    const start = vi.spyOn(second.shell, 'start').mockResolvedValue({ ok: false, reason: 'locked' });
    expect(await second.setup.useVault(listed.vaults[0]!.vaultId)).toEqual({ ok: false, reason: 'locked' });
    expect(start).toHaveBeenCalledWith({ byUser: true });
    start.mockRestore();
    expect(await second.setup.vaultName()).toBe('Shared');
    expect(await second.setup.useVault(listed.vaults[0]!.vaultId)).toEqual({ ok: true });
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
    expect(shell.setupNeeded).toBe(false);
    await shell.stop();
    expect(shell.setupNeeded).toBe(false);
  }, 60_000);
});
