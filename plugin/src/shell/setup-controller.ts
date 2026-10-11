// The setup steps and the account actions behind the settings tab, with no
// Obsidian UI classes in it: sign in, set up or unlock the keys, choose or
// create the vault, confirm which files not to sync (which starts syncing),
// and the device list. The tab only calls this and renders what it returns.
import type { ApiClient, FetchLike } from '../api/client';
import { ApiError, ErrorCode } from '../api/errors';
import type { DeviceInfo, TotpSetup, TotpStatus } from '../api/types';
import * as account from '../services/account';
import { KeysAlreadySetUpError, PassphraseIsPasswordError, WeakPassphraseError, type PasswordFingerprint } from '../services/account';
import * as vaults from '../services/vaults';
import { cryptoRandom } from '../util/random';
import type { UserKeys } from '../crypto/userkeys';
import type { LocalState, Session } from '../state/store';
import type { ShellController, StartResult } from './controller';
import { nextStep, type SetupStep } from './steps';

export interface SetupOptions {
  state: LocalState;
  fetch: FetchLike;
  shell: ShellController;
}

/** What setupKeys did: new keys (their recovery words), or none because another device set them up first. */
export type SetupKeysResult = { recoveryWords: string } | { alreadySetUp: KeysAlreadySetUpError };

/**
 * The storage figures the settings tab shows. vaultBytes is this device's
 * vault, given only when the account owns more than one vault (else it is
 * the total) and owns this one.
 */
export interface StorageUsage {
  usedBytes: number;
  quotaBytes: number;
  vaultBytes: number | null;
}

/** The vaults on the server, or locked: this device has no keys (unlock first). */
export type RemoteVaults = { locked: true } | { locked: false; vaults: vaults.RemoteVaultSummary[] };

/** The server asks for the second factor: show the code field and sign in again with it. */
export function isSecondFactorRequired(err: unknown): boolean {
  return err instanceof ApiError && err.code === ErrorCode.SECOND_FACTOR_REQUIRED;
}

export class SetupController {
  /**
   * A salted digest of the password of the last sign-in, to refuse it as
   * the passphrase. Memory only: null after a plugin reload.
   */
  private passwordFingerprint: PasswordFingerprint | null = null;

  constructor(private readonly o: SetupOptions) {}

  /** Which setup screen comes next. */
  step(): Promise<SetupStep> {
    return nextStep(this.o.state, { fetch: this.o.fetch });
  }

  /** The signed-in session; throws when this device is not signed in. */
  async session(): Promise<Session> {
    const s = await this.o.state.getSession();
    if (!s) throw new Error('You are not signed in.');
    return s;
  }

  /** The name of the vault this device syncs, if one is chosen. */
  async vaultName(): Promise<string | null> {
    return (await this.o.state.getVault())?.name ?? null;
  }

  /** Signs in; totpCode is needed only for an account with two-step sign-in (see isSecondFactorRequired). */
  async login(server: string, username: string, password: string, deviceName: string, platform: string, totpCode = ''): Promise<void> {
    await account.login(this.o.state, server, username, password, deviceName, platform, { fetch: this.o.fetch, totpCode: totpCode.trim() });
    this.passwordFingerprint = await account.passwordFingerprint(password);
  }

  /**
   * Checks the new passphrase (not the account password of the last
   * sign-in, the strength rule, both entries the same) and sets up the
   * keys, or uploads this device's keys again (re-upload).
   */
  async setupKeys(passphrase: string, repeated: string): Promise<SetupKeysResult> {
    // Without a fingerprint (the plugin was reloaded between signing in and this step) the check is skipped: the password is never stored.
    if (this.passwordFingerprint && await account.matchesPassword(this.passwordFingerprint, passphrase)) throw new PassphraseIsPasswordError();
    if (!account.isStrongPassphrase(passphrase)) throw new WeakPassphraseError();
    if (passphrase !== repeated) throw new Error('The two passphrases are not the same.');
    const session = await this.session();
    let result: SetupKeysResult;
    try {
      const { recoveryWords } = await account.setupKeys(this.o.state, this.api(session), session, passphrase);
      result = { recoveryWords };
    } catch (err) {
      // Another device finished the setup first: unlock with its passphrase instead.
      if (!(err instanceof KeysAlreadySetUpError)) throw err;
      result = { alreadySetUp: err };
    }
    this.passwordFingerprint = null;
    return result;
  }

  acknowledgeRecoveryWords(): Promise<void> {
    return account.acknowledgeRecoveryWords(this.o.state);
  }

  async unlockWithPassphrase(passphrase: string): Promise<void> {
    const session = await this.session();
    await account.unlockWithPassphraseService(this.o.state, this.api(session), session, passphrase);
  }

  async unlockWithRecoveryWords(words: string): Promise<void> {
    const session = await this.session();
    await account.unlockWithRecoveryService(this.o.state, this.api(session), session, words);
  }

  async remoteVaults(): Promise<RemoteVaults> {
    const session = await this.session();
    const keys = await account.loadUserKeys(this.o.state, session.userId);
    if (!keys) return { locked: true };
    return { locked: false, vaults: await vaults.listRemoteVaults(this.api(session), session, keys) };
  }

  /** Switches this device to the server's vault vaultId; it syncs once confirmIgnores is called. */
  useVault(vaultId: string): Promise<void> {
    return this.switchVault((api, session, keys) => vaults.chooseVault(this.o.state, api, session, keys, vaultId, { ignoresUnconfirmed: true }));
  }

  /** Creates a new, empty vault on the server and switches this device to it; it syncs once confirmIgnores is called. */
  createVault(name: string): Promise<void> {
    if (name.trim() === '') return Promise.reject(new Error('Give the vault a name.'));
    return this.switchVault((api, session, keys) => vaults.createVault(this.o.state, api, session, keys, name.trim(), cryptoRandom, { ignoresUnconfirmed: true }));
  }

  /**
   * The ignore step of the setup: saves the rules (InvalidIgnorePatternError
   * for unsupported syntax, and then nothing changes), lets the chosen vault
   * sync and starts syncing with them. Nothing was uploaded before.
   */
  async confirmIgnores(globs: string[]): Promise<StartResult> {
    await this.o.shell.setIgnoreGlobs(globs);
    await vaults.confirmIgnores(this.o.state);
    return this.o.shell.start({ byUser: true });
  }

  async devices(): Promise<DeviceInfo[]> {
    return account.listDevices(this.api(await this.session()));
  }

  /** The account's storage use, or null from a server without the route. */
  async storageUsage(): Promise<StorageUsage | null> {
    const session = await this.session();
    const vault = await this.o.state.getVault();
    const u = await this.api(session).usage();
    if (!u) return null;
    const vaultBytes = u.vaults.size > 1 && vault ? u.vaults.get(vault.vaultId) ?? null : null;
    return { usedBytes: u.usedBytes, quotaBytes: u.quotaBytes, vaultBytes };
  }

  /** Whether the account has two-step sign-in on, or null from a server without it (any 404). */
  async twoStepStatus(): Promise<TotpStatus | null> {
    try {
      return await this.api(await this.session()).totpStatus();
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) return null;
      throw err;
    }
  }

  /** Starts turning two-step sign-in on: a new secret for the authenticator app. */
  async twoStepBegin(password: string): Promise<TotpSetup> {
    return this.api(await this.session()).totpBegin(password);
  }

  /** Turns two-step sign-in on with the first code; returns the recovery codes, shown only now. */
  async twoStepConfirm(code: string): Promise<string[]> {
    return this.api(await this.session()).totpConfirm(code.trim());
  }

  async twoStepDisable(password: string, code: string): Promise<void> {
    await this.api(await this.session()).totpDisable(password, code.trim());
  }

  async twoStepNewRecoveryCodes(password: string, code: string): Promise<string[]> {
    return this.api(await this.session()).totpNewRecoveryCodes(password, code.trim());
  }

  async removeDevice(deviceId: string): Promise<void> {
    await account.revokeDevice(this.api(await this.session()), deviceId);
  }

  /**
   * The vault switch: no engine may run while the vault state is replaced,
   * so syncing stops for good first; confirmIgnores then starts it.
   */
  private async switchVault(choose: (api: ApiClient, session: Session, keys: UserKeys) => Promise<unknown>): Promise<void> {
    const session = await this.session();
    const keys = await account.loadUserKeys(this.o.state, session.userId);
    if (!keys) throw new Error('This device is locked. Open the settings again to unlock it.');
    await this.o.shell.stopForGood();
    await choose(this.api(session), session, keys);
  }

  private api(session: Session): ApiClient {
    return account.apiFor(session, { fetch: this.o.fetch });
  }
}
