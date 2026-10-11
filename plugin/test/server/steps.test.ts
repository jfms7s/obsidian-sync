// Which setup screen the settings tab shows next, against the real server.
import { IDBFactory } from 'fake-indexeddb';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { NetworkError } from '../../src/api/errors';
import * as account from '../../src/services/account';
import { chooseVault, createVault } from '../../src/services/vaults';
import { nextStep } from '../../src/shell/steps';
import { LocalState } from '../../src/state/store';
import { generateUserKeys } from '../../src/crypto/userkeys';
import { seededRandom } from '../../src/util/random';
import { Net } from '../helpers/net';
import { newUser, TEST_ARGON2, PASSPHRASE } from '../helpers/fixture';
import { startServer, type TestServer } from '../helpers/server';

let srv: TestServer;
beforeAll(async () => {
  srv = await startServer(inject('obsyncBin'));
});
afterAll(() => srv?.stop());

describe('nextStep', () => {
  it('walks a first device through login, key setup, the recovery words and the vault', async () => {
    const user = await newUser(srv);
    const net = new Net();
    const deps = { fetch: net.fetch };
    const state = await LocalState.open(new IDBFactory(), 'first');
    const r = seededRandom(11);
    expect(await nextStep(state, deps)).toEqual({ kind: 'login' });

    const session = await account.login(state, srv.url, user.username, user.password, 'Laptop', 'test', deps);
    expect(await nextStep(state, deps)).toEqual({ kind: 'setup-keys', reupload: false });

    const api = account.apiFor(session, deps);
    const { recoveryWords, keys } = await account.setupKeys(state, api, session, PASSPHRASE, r, TEST_ARGON2);
    // The words stay on screen until they are confirmed, also after a restart.
    expect(await nextStep(state, deps)).toEqual({ kind: 'confirm-recovery', words: recoveryWords });
    await account.acknowledgeRecoveryWords(state);
    expect(await nextStep(state, deps)).toEqual({ kind: 'choose-vault' });

    await createVault(state, api, session, keys, 'My vault', r);
    expect(await nextStep(state, deps)).toEqual({ kind: 'ready' });
  });

  it('asks a second device to unlock, then to choose a vault', async () => {
    const user = await newUser(srv);
    const r = seededRandom(12);
    const first = await LocalState.open(new IDBFactory(), 'a');
    const s1 = await account.login(first, srv.url, user.username, user.password, 'Laptop', 'test');
    const api1 = account.apiFor(s1);
    const { keys } = await account.setupKeys(first, api1, s1, PASSPHRASE, r, TEST_ARGON2);
    await account.acknowledgeRecoveryWords(first);
    const vault = await createVault(first, api1, s1, keys, 'Shared', r);

    const second = await LocalState.open(new IDBFactory(), 'b');
    const s2 = await account.login(second, srv.url, user.username, user.password, 'Phone', 'test');
    expect(await nextStep(second)).toEqual({ kind: 'unlock' });
    const api2 = account.apiFor(s2);
    const keys2 = await account.unlockWithPassphraseService(second, api2, s2, PASSPHRASE);
    expect(await nextStep(second)).toEqual({ kind: 'choose-vault' });
    await chooseVault(second, api2, s2, keys2, vault.vaultId);
    expect(await nextStep(second)).toEqual({ kind: 'ready' });
  });

  it('asks to set the passphrase again when the server lost the keys this device holds', async () => {
    const user = await newUser(srv);
    const state = await LocalState.open(new IDBFactory(), 'reupload');
    const session = await account.login(state, srv.url, user.username, user.password, 'Laptop', 'test');
    const keys = generateUserKeys(seededRandom(14));
    await state.setUserKeys({ userId: session.userId, encPriv: keys.encPriv, signSeed: keys.signSeed });
    expect(await nextStep(state)).toEqual({ kind: 'setup-keys', reupload: true });
  });

  it('asks to choose a vault when the stored one belongs to the account that signed in before', async () => {
    const r = seededRandom(15);
    const state = await LocalState.open(new IDBFactory(), 'other-user-vault');
    const first = await newUser(srv);
    const s1 = await account.login(state, srv.url, first.username, first.password, 'Laptop', 'test');
    const k1 = (await account.setupKeys(state, account.apiFor(s1), s1, PASSPHRASE, r, TEST_ARGON2)).keys;
    await account.acknowledgeRecoveryWords(state);
    await createVault(state, account.apiFor(s1), s1, k1, 'Theirs', r);
    const second = await newUser(srv);
    const s2 = await account.login(state, srv.url, second.username, second.password, 'Laptop', 'test');
    await account.setupKeys(state, account.apiFor(s2), s2, PASSPHRASE, r, TEST_ARGON2);
    await account.acknowledgeRecoveryWords(state);
    expect((await state.getVault())?.userId).toBe(s1.userId);
    expect(await nextStep(state)).toEqual({ kind: 'choose-vault' });
  });

  it('keeps a configured device syncing while offline, and reports a missing connection otherwise', async () => {
    const user = await newUser(srv);
    const net = new Net();
    const deps = { fetch: net.fetch };
    const r = seededRandom(13);
    const state = await LocalState.open(new IDBFactory(), 'off');
    const session = await account.login(state, srv.url, user.username, user.password, 'Laptop', 'test', deps);
    const api = account.apiFor(session, deps);
    const { keys } = await account.setupKeys(state, api, session, PASSPHRASE, r, TEST_ARGON2);
    await account.acknowledgeRecoveryWords(state);
    net.setOnline(false);
    // Keys but no vault yet: the next step needs the server.
    await expect(nextStep(state, deps)).rejects.toBeInstanceOf(NetworkError);
    net.setOnline(true);
    await createVault(state, api, session, keys, 'V', r);
    net.setOnline(false);
    expect(await nextStep(state, deps)).toEqual({ kind: 'ready' });
  });
});
