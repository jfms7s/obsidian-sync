// Account and key services for the settings tab (plan 3): login, first-time
// key setup, unlocking a new device, passphrase change, devices.
import { ApiClient, type FetchLike } from '../api/client';
import { ApiError, ErrorCode } from '../api/errors';
import type { DeviceInfo, KeyBundleFields } from '../api/types';
import { normalizeServerUrl } from '../api/url';
import {
  createKeyBundle, rewrapPassphrase, unlockWithPassphrase, unlockWithRecoveryWords, userKeysFromSecrets,
  DEFAULT_ARGON2, type Argon2Params, type UserKeys,
} from '../crypto/userkeys';
import { CryptoError } from '../crypto/primitives';
import type { LocalState, PendingKeySetup, Session } from '../state/store';
import { equalBytes } from '../util/bytes';
import type { Clock } from '../util/clock';
import { cryptoRandom, type Random } from '../util/random';

export interface ClientDeps {
  fetch?: FetchLike;
  clock?: Clock;
}

export function apiFor(session: Pick<Session, 'serverUrl' | 'token'>, deps: ClientDeps = {}): ApiClient {
  return new ApiClient({ baseUrl: session.serverUrl, token: session.token, ...deps });
}

/** Logs this device in and stores the session. */
export async function login(
  state: LocalState, serverUrl: string, username: string, password: string, deviceName: string, platform: string, deps: ClientDeps = {},
): Promise<Session> {
  const baseUrl = normalizeServerUrl(serverUrl);
  const api = new ApiClient({ baseUrl, ...deps });
  const r = await api.login(username, password, deviceName, platform);
  const session: Session = { serverUrl: baseUrl, username, userId: r.userId, deviceId: r.deviceId, deviceName, token: r.token };
  await state.setSession(session);
  return session;
}

/**
 * Revokes this device's token (best effort) and forgets the session, the
 * unlocked keys, any unfinished key setup and all sync state, so the next
 * account to log in here starts clean.
 */
export async function logout(state: LocalState, deps: ClientDeps = {}): Promise<void> {
  const session = await state.getSession();
  if (session) {
    try {
      await apiFor(session, deps).logout();
    } catch {
      // Offline or already revoked: forgetting locally is what matters.
    }
  }
  await state.resetVaultState();
  await state.clearUserKeys();
  await state.clearPendingKeySetup();
  await state.clearSession();
}

/**
 * - 'needs-setup': the account has no keys yet: setupKeys.
 * - 'needs-unlock': the account has keys this device does not hold: unlock
 *   with the passphrase or the recovery words.
 * - 'needs-reupload': this device holds the account's keys but the server
 *   has no bundle (it lost it, e.g. restored from an older backup): call
 *   setupKeys, which uploads these keys again with a new passphrase wrap
 *   and new recovery words, so vaults sealed to them stay readable.
 * - 'unlocked': ready to sync.
 */
export type KeyStatus = 'needs-setup' | 'needs-unlock' | 'needs-reupload' | 'unlocked';

/** Thrown by setupKeys when another device finished setup first: unlock with the passphrase instead. */
export class KeysAlreadySetUpError extends Error {
  constructor() {
    super('this account already has keys (set up on another device); unlock with the passphrase or recovery words');
    this.name = 'KeysAlreadySetUpError';
  }
}

/**
 * Thrown by setupKeys when an earlier attempt, with another passphrase,
 * reached the server although its response was lost: that setup is
 * finished (keys stored, recovery words to confirm) and its passphrase is
 * the one in effect. Change it with changePassphrase if wanted.
 */
export class SetupPassphraseMismatchError extends Error {
  constructor() {
    super('the keys were already set up with the passphrase entered first; use that one, or change it in the settings');
    this.name = 'SetupPassphraseMismatchError';
  }
}

const samePublicKeys = (a: KeyBundleFields, b: KeyBundleFields) =>
  equalBytes(a.publicEncKey, b.publicEncKey) && equalBytes(a.publicSignKey, b.publicSignKey);

/** Records that pending's bundle is on the server and stores its keys. */
async function finishSetup(state: LocalState, pending: PendingKeySetup): Promise<PendingKeySetup> {
  const done = { ...pending, uploaded: true };
  await state.setPendingKeySetup(done);
  await state.setUserKeys(done.keys);
  return done;
}

/**
 * Whether this device can sync. Stored keys count only if they belong to
 * this session's account and match the bundle on the server; keys of
 * another account, or that do not match the server's bundle, are dropped.
 * Keys of this account are kept when the server has no bundle at all
 * ('needs-reupload').
 *
 * An unfinished setup whose bundle is on the server (its upload landed but
 * the response was lost) is finished here: the bundle is resent (the
 * server accepts an identical one), the keys stored, and the recovery
 * words become available through recoveryWordsToConfirm.
 */
export async function keyStatus(state: LocalState, api: ApiClient, session: Session): Promise<KeyStatus> {
  const bundle = await api.getKeyBundle();
  const pending = await state.getPendingKeySetup();
  if (pending && pending.userId === session.userId && !pending.uploaded && bundle && samePublicKeys(bundle, pending.bundle)) {
    try {
      await api.putKeyBundle(pending.bundle);
      await finishSetup(state, pending);
      return 'unlocked';
    } catch (err) {
      if (!(err instanceof ApiError && err.code === ErrorCode.WRONG_PASSWORD)) throw err;
      // Same keys, but another bundle (another device re-uploaded them): these recovery words are not valid.
      await state.clearPendingKeySetup();
    }
  }
  const stored = await state.getUserKeys();
  if (stored) {
    const keys = userKeysFromSecrets(stored.encPriv, stored.signSeed);
    if (stored.userId === session.userId) {
      if (!bundle) return 'needs-reupload';
      if (equalBytes(keys.encPub, bundle.publicEncKey) && equalBytes(keys.signPub, bundle.publicSignKey)) return 'unlocked';
    }
    await state.clearUserKeys();
  }
  return bundle ? 'needs-unlock' : 'needs-setup';
}

async function passphraseOpens(bundle: KeyBundleFields, userId: string, passphrase: string): Promise<boolean> {
  try {
    await unlockWithPassphrase(bundle, userId, passphrase);
    return true;
  } catch (err) {
    if (err instanceof CryptoError) return false;
    throw err;
  }
}

/**
 * First-time setup on the user's first device: creates the keypairs and
 * the recovery key, uploads the bundle, and keeps the keys on this device.
 * Returns the 24 recovery words. They stay stored (see
 * recoveryWordsToConfirm) until acknowledgeRecoveryWords is called, so a
 * restart before the user wrote them down does not lose them.
 *
 * If this device already holds the account's keys (keyStatus
 * 'needs-reupload'), those keys are uploaded again instead of new ones,
 * with new recovery words.
 *
 * If an earlier attempt did not finish, its bundle is resent unchanged when
 * passphrase opens it: the server accepts an identical re-send, while a
 * different one would need the account password. With another passphrase,
 * the earlier attempt is discarded and setup starts over, unless that
 * attempt reached the server after all: then it is finished and
 * SetupPassphraseMismatchError says so. If another device set up keys
 * first, the server refuses (WRONG_PASSWORD); the unfinished setup is
 * discarded and KeysAlreadySetUpError tells the UI to offer unlocking
 * instead.
 */
export async function setupKeys(
  state: LocalState, api: ApiClient, session: Session, passphrase: string, random: Random = cryptoRandom, params: Argon2Params = DEFAULT_ARGON2,
): Promise<{ recoveryWords: string; keys: UserKeys }> {
  let pending = await state.getPendingKeySetup();
  if (pending && pending.userId !== session.userId) {
    await state.clearPendingKeySetup();
    pending = undefined;
  }
  if (pending && !pending.uploaded && !(await passphraseOpens(pending.bundle, session.userId, passphrase))) {
    const onServer = await api.getKeyBundle();
    if (onServer && samePublicKeys(onServer, pending.bundle)) {
      await finishSetup(state, pending);
      throw new SetupPassphraseMismatchError();
    }
    await state.clearPendingKeySetup();
    pending = undefined;
  }
  if (!pending) {
    const stored = await state.getUserKeys();
    const existing = stored && stored.userId === session.userId ? userKeysFromSecrets(stored.encPriv, stored.signSeed) : undefined;
    const created = await createKeyBundle(session.userId, passphrase, random, params, existing);
    pending = {
      userId: session.userId, bundle: created.bundle, recoveryWords: created.recoveryWords, uploaded: false,
      keys: { userId: session.userId, encPriv: created.keys.encPriv, signSeed: created.keys.signSeed },
    };
    await state.setPendingKeySetup(pending);
  }
  if (!pending.uploaded) {
    try {
      await api.putKeyBundle(pending.bundle);
    } catch (err) {
      if (err instanceof ApiError && err.code === ErrorCode.WRONG_PASSWORD) {
        await state.clearPendingKeySetup();
        throw new KeysAlreadySetUpError();
      }
      throw err;
    }
  }
  pending = await finishSetup(state, pending);
  return { recoveryWords: pending.recoveryWords, keys: userKeysFromSecrets(pending.keys.encPriv, pending.keys.signSeed) };
}

/** Recovery words from a finished setup that the user has not confirmed yet (show them again), or null. */
export async function recoveryWordsToConfirm(state: LocalState, session: Session): Promise<string | null> {
  const pending = await state.getPendingKeySetup();
  return pending && pending.uploaded && pending.userId === session.userId ? pending.recoveryWords : null;
}

/** The user confirmed writing the recovery words down: forget them. */
export async function acknowledgeRecoveryWords(state: LocalState): Promise<void> {
  const pending = await state.getPendingKeySetup();
  if (pending?.uploaded) await state.clearPendingKeySetup();
}

async function bundleOrThrow(api: ApiClient): Promise<KeyBundleFields> {
  const kb = await api.getKeyBundle();
  if (!kb) throw new Error('this account has no keys yet; set them up on your first device');
  return kb;
}

/**
 * Unlocks a new device with the encryption passphrase. Throws CryptoError if
 * it is wrong, except Argon2TooCostlyError (a CryptoError subclass, check it
 * first): the bundle asks for more Argon2 work than this device allows.
 */
export async function unlockWithPassphraseService(state: LocalState, api: ApiClient, session: Session, passphrase: string): Promise<UserKeys> {
  const keys = await unlockWithPassphrase(await bundleOrThrow(api), session.userId, passphrase);
  await state.setUserKeys({ userId: session.userId, encPriv: keys.encPriv, signSeed: keys.signSeed });
  return keys;
}

/** Unlocks a new device with the 24 recovery words. */
export async function unlockWithRecoveryService(state: LocalState, api: ApiClient, session: Session, words: string): Promise<UserKeys> {
  const keys = await unlockWithRecoveryWords(await bundleOrThrow(api), session.userId, words);
  await state.setUserKeys({ userId: session.userId, encPriv: keys.encPriv, signSeed: keys.signSeed });
  return keys;
}

/** The unlocked keys stored on this device for userId, if any (no network; keyStatus also checks the server). */
export async function loadUserKeys(state: LocalState, userId: string): Promise<UserKeys | null> {
  const k = await state.getUserKeys();
  return k && k.userId === userId ? userKeysFromSecrets(k.encPriv, k.signSeed) : null;
}

/**
 * Changes the encryption passphrase. The server requires the account
 * (login) password to replace the bundle: a wrong one is ApiError
 * WRONG_PASSWORD (403).
 */
export async function changePassphrase(
  api: ApiClient, session: Session, keys: UserKeys, newPassphrase: string, accountPassword: string, random: Random = cryptoRandom,
): Promise<void> {
  const current = await bundleOrThrow(api);
  await api.putKeyBundle(await rewrapPassphrase(current, session.userId, keys, newPassphrase, random), accountPassword);
}

export function listDevices(api: ApiClient): Promise<DeviceInfo[]> {
  return api.listDevices();
}

export function revokeDevice(api: ApiClient, deviceId: string): Promise<void> {
  return api.revokeDevice(deviceId);
}
