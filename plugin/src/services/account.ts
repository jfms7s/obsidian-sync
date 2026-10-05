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
import type { LocalState, Session } from '../state/store';
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

export type KeyStatus = 'needs-setup' | 'needs-unlock' | 'unlocked';

/** Thrown by setupKeys when another device finished setup first: unlock with the passphrase instead. */
export class KeysAlreadySetUpError extends Error {
  constructor() {
    super('this account already has keys (set up on another device); unlock with the passphrase or recovery words');
    this.name = 'KeysAlreadySetUpError';
  }
}

/**
 * Whether this device can sync. Stored keys count only if they belong to
 * this session's account and match the bundle on the server; otherwise
 * they are dropped.
 */
export async function keyStatus(state: LocalState, api: ApiClient, session: Session): Promise<KeyStatus> {
  const bundle = await api.getKeyBundle();
  const stored = await state.getUserKeys();
  if (stored) {
    const keys = userKeysFromSecrets(stored.encPriv, stored.signSeed);
    if (stored.userId === session.userId && bundle && equalBytes(keys.encPub, bundle.publicEncKey) && equalBytes(keys.signPub, bundle.publicSignKey)) {
      return 'unlocked';
    }
    await state.clearUserKeys();
  }
  return bundle ? 'needs-unlock' : 'needs-setup';
}

/**
 * First-time setup on the user's first device: creates the keypairs and
 * the recovery key, uploads the bundle, and keeps the keys on this device.
 * Returns the 24 recovery words. They stay stored (see
 * recoveryWordsToConfirm) until acknowledgeRecoveryWords is called, so a
 * restart before the user wrote them down does not lose them.
 *
 * If an earlier attempt's response was lost, exactly that bundle is resent:
 * the server accepts an identical re-send, while a different one would need
 * the account password. If another device set up keys first, the server
 * refuses (WRONG_PASSWORD); the unfinished setup is discarded and
 * KeysAlreadySetUpError tells the UI to offer unlocking instead.
 */
export async function setupKeys(
  state: LocalState, api: ApiClient, session: Session, passphrase: string, random: Random = cryptoRandom, params: Argon2Params = DEFAULT_ARGON2,
): Promise<{ recoveryWords: string; keys: UserKeys }> {
  let pending = await state.getPendingKeySetup();
  if (pending && pending.userId !== session.userId) {
    await state.clearPendingKeySetup();
    pending = undefined;
  }
  if (!pending) {
    const created = await createKeyBundle(session.userId, passphrase, random, params);
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
    pending = { ...pending, uploaded: true };
    await state.setPendingKeySetup(pending);
  }
  await state.setUserKeys(pending.keys);
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
