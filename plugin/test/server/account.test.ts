// Account, key and vault services (what plan 3's settings tab calls), against the real server.
import { IDBFactory } from 'fake-indexeddb';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { ApiError, ErrorCode, NetworkError } from '../../src/api/errors';
import { encryptVaultName } from '../../src/crypto/objects';
import { CryptoError } from '../../src/crypto/primitives';
import { Argon2TooCostlyError, createKeyBundle, generateUserKeys } from '../../src/crypto/userkeys';
import { deriveEpochKeys, sealKey } from '../../src/crypto/vaultkeys';
import {
  acknowledgeRecoveryWords, apiFor, changePassphrase, KeysAlreadySetUpError, keyStatus, listDevices, login, logout,
  matchesPassword, PassphraseIsPasswordError, passwordFingerprint, recoveryWordsToConfirm, revokeDevice, SetupPassphraseMismatchError, setupKeys, unlockWithPassphraseService, unlockWithRecoveryService,
} from '../../src/services/account';
import { chooseVault, createVault, listRemoteVaults, openVaultKeys } from '../../src/services/vaults';
import { LocalState } from '../../src/state/store';
import { toHex } from '../../src/util/bytes';
import { seededRandom } from '../../src/util/random';
import { Net } from '../helpers/net';
import { startServer, type TestServer } from '../helpers/server';

const TEST_ARGON2 = { memoryKib: 8192, iterations: 1, parallelism: 1 };

let srv: TestServer;
beforeAll(async () => {
  srv = await startServer(inject('obsyncBin'));
  await srv.createUser('carol', 'carol-password');
});
afterAll(() => srv?.stop());

const newState = (name: string) => LocalState.open(new IDBFactory(), name);

describe('account and keys', () => {
  it('sets up keys once, then unlocks other devices with the passphrase or the recovery words', async () => {
    const s1 = await newState('d1');
    const session = await login(s1, `${srv.url}/`, 'carol', 'carol-password', 'Laptop', 'linux');
    expect(session.serverUrl).toBe(srv.url);
    const api = apiFor(session);
    expect(await keyStatus(s1, api, session)).toBe('needs-setup');
    const { recoveryWords, keys } = await setupKeys(s1, api, session, 'my passphrase', seededRandom(1), TEST_ARGON2);
    expect(await keyStatus(s1, api, session)).toBe('unlocked');

    const s2 = await newState('d2');
    const session2 = await login(s2, srv.url, 'carol', 'carol-password', 'Phone', 'android');
    const api2 = apiFor(session2);
    expect(await keyStatus(s2, api2, session2)).toBe('needs-unlock');
    await expect(unlockWithPassphraseService(s2, api2, session2, 'nope')).rejects.toBeInstanceOf(CryptoError);
    expect((await unlockWithPassphraseService(s2, api2, session2, 'my passphrase')).encPub).toEqual(keys.encPub);

    const s3 = await newState('d3');
    const session3 = await login(s3, srv.url, 'carol', 'carol-password', 'Tablet', 'ios');
    expect((await unlockWithRecoveryService(s3, apiFor(session3), session3, recoveryWords)).signPub).toEqual(keys.signPub);
  });

  it('resends the same bundle when the first upload response was lost', async () => {
    await srv.createUser('frank', 'frank-password');
    const s = await newState('k1');
    const session = await login(s, srv.url, 'frank', 'frank-password', 'Laptop', 'linux');
    const net = new Net();
    const api = apiFor(session, { fetch: net.fetch });
    net.loseNextResponse('PUT', '/v1/keys');
    await expect(setupKeys(s, api, session, 'pp', seededRandom(10), TEST_ARGON2)).rejects.toBeInstanceOf(NetworkError);
    const first = (await s.getPendingKeySetup())!.recoveryWords;
    expect(await recoveryWordsToConfirm(s, session)).toBeNull(); // not uploaded yet
    const done = await setupKeys(s, api, session, 'pp', seededRandom(11), TEST_ARGON2);
    expect(done.recoveryWords).toBe(first);
    expect(await keyStatus(s, api, session)).toBe('unlocked');
  });

  it('finishes a setup whose upload landed although its response was lost when the status is checked', async () => {
    await srv.createUser('olga', 'olga-password');
    const s = await newState('lost-then-status');
    const session = await login(s, srv.url, 'olga', 'olga-password', 'Laptop', 'linux');
    const net = new Net();
    const api = apiFor(session, { fetch: net.fetch });
    net.loseNextResponse('PUT', '/v1/keys');
    await expect(setupKeys(s, api, session, 'pp', seededRandom(30), TEST_ARGON2)).rejects.toBeInstanceOf(NetworkError);
    const words = (await s.getPendingKeySetup())!.recoveryWords;
    // The app restarts and asks for the status before the user retries.
    expect(await keyStatus(s, api, session)).toBe('unlocked');
    expect(await recoveryWordsToConfirm(s, session)).toBe(words);
    const s2 = await newState('lost-then-status-2');
    const session2 = await login(s2, srv.url, 'olga', 'olga-password', 'Phone', 'android');
    const keys = await unlockWithRecoveryService(s2, apiFor(session2), session2, words);
    expect(keys.encPub).toEqual((await unlockWithPassphraseService(s2, apiFor(session2), session2, 'pp')).encPub);
  });

  it('starts over with a new passphrase when the earlier setup never reached the server', async () => {
    await srv.createUser('pia', 'pia-password');
    const s = await newState('new-pp');
    const session = await login(s, srv.url, 'pia', 'pia-password', 'Laptop', 'linux');
    const net = new Net();
    const api = apiFor(session, { fetch: net.fetch });
    net.setOnline(false);
    await expect(setupKeys(s, api, session, 'old pp', seededRandom(31), TEST_ARGON2)).rejects.toBeInstanceOf(NetworkError);
    const first = (await s.getPendingKeySetup())!.recoveryWords;
    net.setOnline(true);
    expect(await keyStatus(s, api, session)).toBe('needs-setup');
    const done = await setupKeys(s, api, session, 'new pp', seededRandom(32), TEST_ARGON2);
    expect(done.recoveryWords).not.toBe(first);
    const s2 = await newState('new-pp-2');
    const session2 = await login(s2, srv.url, 'pia', 'pia-password', 'Phone', 'android');
    expect((await unlockWithPassphraseService(s2, apiFor(session2), session2, 'new pp')).encPub).toEqual(done.keys.encPub);
  });

  it('refuses a different passphrase for a setup that already reached the server', async () => {
    await srv.createUser('quentin', 'quentin-password');
    const s = await newState('landed-pp');
    const session = await login(s, srv.url, 'quentin', 'quentin-password', 'Laptop', 'linux');
    const net = new Net();
    const api = apiFor(session, { fetch: net.fetch });
    net.loseNextResponse('PUT', '/v1/keys');
    await expect(setupKeys(s, api, session, 'pp one', seededRandom(33), TEST_ARGON2)).rejects.toBeInstanceOf(NetworkError);
    const words = (await s.getPendingKeySetup())!.recoveryWords;
    await expect(setupKeys(s, api, session, 'pp two', seededRandom(34), TEST_ARGON2)).rejects.toBeInstanceOf(SetupPassphraseMismatchError);
    expect(await keyStatus(s, api, session)).toBe('unlocked');
    expect(await recoveryWordsToConfirm(s, session)).toBe(words);
    const s2 = await newState('landed-pp-2');
    const session2 = await login(s2, srv.url, 'quentin', 'quentin-password', 'Phone', 'android');
    await expect(unlockWithPassphraseService(s2, apiFor(session2), session2, 'pp one')).resolves.toBeDefined();
  });

  it('keeps its keys when the server has no bundle and uploads them again', async () => {
    await srv.createUser('rosa', 'rosa-password');
    const s = await newState('reupload');
    const session = await login(s, srv.url, 'rosa', 'rosa-password', 'Laptop', 'linux');
    const api = apiFor(session);
    // Keys this device unlocked earlier; the server lost the bundle (e.g. restored from an older backup).
    const old = generateUserKeys(seededRandom(35));
    await s.setUserKeys({ userId: session.userId, encPriv: old.encPriv, signSeed: old.signSeed });
    expect(await keyStatus(s, api, session)).toBe('needs-reupload');
    expect(await s.getUserKeys()).toBeDefined();
    const done = await setupKeys(s, api, session, 'pp', seededRandom(36), TEST_ARGON2);
    expect(done.keys.encPub).toEqual(old.encPub);
    expect(done.keys.signPub).toEqual(old.signPub);
    expect(await keyStatus(s, api, session)).toBe('unlocked');
    const s2 = await newState('reupload-2');
    const session2 = await login(s2, srv.url, 'rosa', 'rosa-password', 'Phone', 'android');
    expect((await unlockWithRecoveryService(s2, apiFor(session2), session2, done.recoveryWords)).encPub).toEqual(old.encPub);
  });

  it('keeps the recovery words across a restart until the user acknowledges them', async () => {
    await srv.createUser('gina', 'gina-password');
    const factory = new IDBFactory();
    const s = await LocalState.open(factory, 'ack');
    const session = await login(s, srv.url, 'gina', 'gina-password', 'Laptop', 'linux');
    const { recoveryWords } = await setupKeys(s, apiFor(session), session, 'pp', seededRandom(12), TEST_ARGON2);
    s.close();
    const reopened = await LocalState.open(factory, 'ack'); // the app restarted before the user confirmed
    expect(await recoveryWordsToConfirm(reopened, session)).toBe(recoveryWords);
    await acknowledgeRecoveryWords(reopened);
    expect(await recoveryWordsToConfirm(reopened, session)).toBeNull();
    expect(await keyStatus(reopened, apiFor(session), session)).toBe('unlocked');
  });

  it('routes to unlock when another device finished setup first', async () => {
    await srv.createUser('hugo', 'hugo-password');
    const s1 = await newState('race1');
    const session1 = await login(s1, srv.url, 'hugo', 'hugo-password', 'Laptop', 'linux');
    const net = new Net();
    net.setOnline(false);
    await expect(setupKeys(s1, apiFor(session1, { fetch: net.fetch }), session1, 'pp1', seededRandom(13), TEST_ARGON2)).rejects.toBeInstanceOf(NetworkError);
    const s2 = await newState('race2');
    const session2 = await login(s2, srv.url, 'hugo', 'hugo-password', 'Phone', 'android');
    await setupKeys(s2, apiFor(session2), session2, 'pp2', seededRandom(14), TEST_ARGON2);
    net.setOnline(true);
    const api1 = apiFor(session1, { fetch: net.fetch });
    await expect(setupKeys(s1, api1, session1, 'pp1', seededRandom(13), TEST_ARGON2)).rejects.toBeInstanceOf(KeysAlreadySetUpError);
    expect(await s1.getPendingKeySetup()).toBeUndefined();
    expect(await keyStatus(s1, api1, session1)).toBe('needs-unlock');
    await unlockWithPassphraseService(s1, api1, session1, 'pp2');
    expect(await keyStatus(s1, api1, session1)).toBe('unlocked');
  });

  it('forgets the keys on logout, so the next account on this device starts clean', async () => {
    await srv.createUser('ivy', 'ivy-password');
    await srv.createUser('jack', 'jack-password');
    const s = await newState('shared-device');
    const ivy = await login(s, srv.url, 'ivy', 'ivy-password', 'Laptop', 'linux');
    await setupKeys(s, apiFor(ivy), ivy, 'ivy pp', seededRandom(15), TEST_ARGON2);
    await logout(s);
    expect(await s.getUserKeys()).toBeUndefined();
    expect(await s.getPendingKeySetup()).toBeUndefined();
    const jack = await login(s, srv.url, 'jack', 'jack-password', 'Laptop', 'linux');
    expect(await keyStatus(s, apiFor(jack), jack)).toBe('needs-setup');
  });

  it('reports a too costly Argon2 bundle as such, not as a wrong passphrase', async () => {
    await srv.createUser('lena', 'lena-password');
    const s = await newState('costly');
    const lena = await login(s, srv.url, 'lena', 'lena-password', 'Laptop', 'linux');
    const api = apiFor(lena);
    // A bundle within the server's caps but beyond what this device will compute.
    const { bundle } = await createKeyBundle(lena.userId, 'pp', seededRandom(16), TEST_ARGON2);
    await api.putKeyBundle({ ...bundle, passParams: { ...TEST_ARGON2, iterations: 17 } });
    const err = await unlockWithPassphraseService(s, api, lena, 'pp').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Argon2TooCostlyError);
    expect(await s.getUserKeys()).toBeUndefined();
  });

  it('drops stored keys that belong to another account', async () => {
    await srv.createUser('kim', 'kim-password');
    const s = await newState('stale-keys');
    const kim = await login(s, srv.url, 'kim', 'kim-password', 'Laptop', 'linux');
    await s.setUserKeys({ userId: 'ffffffffffffffffffffffffffffffff', encPriv: new Uint8Array(32).fill(1), signSeed: new Uint8Array(32).fill(2) });
    expect(await keyStatus(s, apiFor(kim), kim)).toBe('needs-setup');
    expect(await s.getUserKeys()).toBeUndefined();
  });

  it('needs the account password to change the passphrase', async () => {
    const s = await newState('d4');
    const session = await login(s, srv.url, 'carol', 'carol-password', 'Desk', 'linux');
    const api = apiFor(session);
    const keys = await unlockWithPassphraseService(s, api, session, 'my passphrase');
    await expect(changePassphrase(api, session, keys, 'new passphrase', 'wrong-password', seededRandom(2)))
      .rejects.toMatchObject({ code: ErrorCode.WRONG_PASSWORD, status: 403 });
    await changePassphrase(api, session, keys, 'new passphrase', 'carol-password', seededRandom(3));
    expect((await unlockWithPassphraseService(await newState('d5'), api, session, 'new passphrase')).encPub).toEqual(keys.encPub);
  });

  it('refuses a new passphrase equal to the account password before sending anything', async () => {
    const s = await newState('d4b');
    const session = await login(s, srv.url, 'carol', 'carol-password', 'Desk', 'linux');
    const net = new Net();
    await expect(changePassphrase(apiFor(session, { fetch: net.fetch }), session, generateUserKeys(seededRandom(4)), 'carol-password', 'carol-password', seededRandom(4)))
      .rejects.toBeInstanceOf(PassphraseIsPasswordError);
    expect(net.log).toEqual([]);
  });

  it('recognises the account password from its fingerprint, and nothing else', async () => {
    const fp = await passwordFingerprint('carol-password', seededRandom(5));
    expect(await matchesPassword(fp, 'carol-password')).toBe(true);
    expect(await matchesPassword(fp, 'carol-password ')).toBe(false);
    expect(await matchesPassword(fp, 'another passphrase')).toBe(false);
    const other = await passwordFingerprint('carol-password', seededRandom(6));
    expect(toHex(other.digest)).not.toBe(toHex(fp.digest));
  });

  it('lists and revokes devices, and a logged-out device is refused', async () => {
    const s = await newState('d6');
    const session = await login(s, srv.url, 'carol', 'carol-password', 'Old phone', 'android');
    const other = await newState('d7');
    const otherSession = await login(other, srv.url, 'carol', 'carol-password', 'Admin laptop', 'linux');
    const devices = await listDevices(apiFor(otherSession));
    expect(devices.find((d) => d.current)?.name).toBe('Admin laptop');
    await revokeDevice(apiFor(otherSession), session.deviceId);
    const err = await apiFor(session).listVaults().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe(ErrorCode.DEVICE_REVOKED);
    await logout(other);
    expect(await other.getSession()).toBeUndefined();
  });
});

describe('vaults', () => {
  it('creates a vault with an encrypted name, lists it and chooses it elsewhere', async () => {
    await srv.createUser('dave', 'dave-password');
    const s1 = await newState('v1');
    const session = await login(s1, srv.url, 'dave', 'dave-password', 'A', 'linux');
    const api = apiFor(session);
    const { keys } = await setupKeys(s1, api, session, 'pp', seededRandom(4), TEST_ARGON2);
    const created = await createVault(s1, api, session, keys, 'Personal notes', seededRandom(5));
    const listed = await listRemoteVaults(api, session, keys);
    expect(listed).toEqual([expect.objectContaining({ vaultId: created.vaultId, name: 'Personal notes', owned: true })]);
    const s2 = await newState('v2');
    const session2 = await login(s2, srv.url, 'dave', 'dave-password', 'B', 'linux');
    const keys2 = await unlockWithPassphraseService(s2, apiFor(session2), session2, 'pp');
    const chosen = await chooseVault(s2, apiFor(session2), session2, keys2, created.vaultId);
    expect(chosen.name).toBe('Personal notes');
    expect(chosen.namingKey).toEqual(created.namingKey);
  });

  it('retries a vault creation whose response was lost with the same vault and keys', async () => {
    await srv.createUser('sven', 'sven-password');
    const s = await newState('lost-vault');
    const session = await login(s, srv.url, 'sven', 'sven-password', 'A', 'linux');
    const net = new Net();
    const api = apiFor(session, { fetch: net.fetch });
    const { keys } = await setupKeys(s, api, session, 'pp', seededRandom(40), TEST_ARGON2);
    net.loseNextResponse('POST', '/v1/vaults');
    await expect(createVault(s, api, session, keys, 'Notes', seededRandom(41))).rejects.toBeInstanceOf(NetworkError);
    const created = await createVault(s, api, session, keys, 'Notes', seededRandom(42));
    expect(await listRemoteVaults(api, session, keys)).toEqual([expect.objectContaining({ vaultId: created.vaultId, name: 'Notes' })]);
    expect(await s.getVault()).toMatchObject({ vaultId: created.vaultId });
    const opened = await openVaultKeys(await api.vaultKeys(created.vaultId), created.vaultId, session, keys);
    expect(opened.namingKey).toEqual(created.namingKey);
    expect(opened.epochKeys.get(1)).toEqual(new Map(created.epochKeys).get(1));
  });

  it('retries a vault creation that never reached the server with the same vault id', async () => {
    await srv.createUser('tara', 'tara-password');
    const s = await newState('offline-vault');
    const session = await login(s, srv.url, 'tara', 'tara-password', 'A', 'linux');
    const net = new Net();
    const api = apiFor(session, { fetch: net.fetch });
    const { keys } = await setupKeys(s, api, session, 'pp', seededRandom(43), TEST_ARGON2);
    net.setOnline(false);
    await expect(createVault(s, api, session, keys, 'Notes', seededRandom(44))).rejects.toBeInstanceOf(NetworkError);
    net.setOnline(true);
    const created = await createVault(s, api, session, keys, 'Notes', seededRandom(45));
    // seededRandom(44) generated the id on the first attempt.
    expect(created.vaultId).toBe(toHex(seededRandom(44).bytes(16)));
    expect(await listRemoteVaults(api, session, keys)).toHaveLength(1);
  });

  it('rejects a seal signed by a key from a substituted bundle', async () => {
    // A malicious server plants a vault whose keys it knows, sealed to the
    // user but signed by its own key, and serves a bundle whose
    // public_sign_key is that key. The seals must be checked against the locally unlocked
    // keys.signPub, so the planted vault is refused.
    await srv.createUser('mia', 'mia-password');
    const s = await newState('planted');
    const session = await login(s, srv.url, 'mia', 'mia-password', 'A', 'linux');
    const api = apiFor(session);
    const { keys } = await setupKeys(s, api, session, 'pp', seededRandom(20), TEST_ARGON2);
    const r = seededRandom(21);
    const attacker = generateUserKeys(r);
    const vaultId = toHex(r.bytes(16));
    const namingKey = r.bytes(32);
    const epochKey = r.bytes(32);
    const sealed = [
      { epoch: 0, sealedKey: await sealKey(r, keys.encPub, namingKey, vaultId, 0, session.userId, attacker.signSeed) },
      { epoch: 1, sealedKey: await sealKey(r, keys.encPub, epochKey, vaultId, 1, session.userId, attacker.signSeed) },
    ];
    const encName = await encryptVaultName(r, vaultId, await deriveEpochKeys(vaultId, 1, epochKey), 'Planted', attacker.signSeed);
    await api.createVault(vaultId, encName, sealed);
    // The real server refuses to change public keys, so the substitution is
    // simulated on this client: every bundle it fetches now names the attacker.
    const bundle = (await api.getKeyBundle())!;
    api.getKeyBundle = () => Promise.resolve({ ...bundle, publicSignKey: attacker.signPub });
    // Control: verified against the substituted key, the planted seals would open.
    expect((await openVaultKeys(await api.vaultKeys(vaultId), vaultId, session, { ...keys, signPub: attacker.signPub })).namingKey).toEqual(namingKey);

    await expect(openVaultKeys(await api.vaultKeys(vaultId), vaultId, session, keys)).rejects.toBeInstanceOf(CryptoError);
    expect(await listRemoteVaults(api, session, keys)).toEqual([expect.objectContaining({ vaultId, name: null })]);
    await expect(chooseVault(s, api, session, keys, vaultId)).rejects.toBeInstanceOf(CryptoError);
    expect(await s.getVault()).toBeUndefined();
  });
});
