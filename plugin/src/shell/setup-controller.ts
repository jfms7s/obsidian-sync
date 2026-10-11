// The setup steps and the account actions behind the settings tab, with no
// Obsidian UI classes in it: sign in, set up or unlock the keys, choose or
// create the vault (which also starts syncing), and the device list. The tab
// only calls this and renders what it returns.
import type { ApiClient, FetchLike } from '../api/client';
import type { DeviceInfo } from '../api/types';
import * as account from '../services/account';
import { KeysAlreadySetUpError, PassphraseIsPasswordError, WeakPassphraseError, type PasswordFingerprint } from '../services/account';
import * as vaults from '../services/vaults';
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

/** The vaults on the server, or locked: this device has no keys (unlock first). */
export type RemoteVaults = { locked: true } | { locked: false; vaults: vaults.RemoteVaultSummary[] };

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

  async login(server: string, username: string, password: string, deviceName: string, platform: string): Promise<void> {
    await account.login(this.o.state, server, username, password, deviceName, platform, { fetch: this.o.fetch });
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

  /** Switches this device to the server's vault vaultId: stops syncing, chooses it, starts again. */
  useVault(vaultId: string): Promise<StartResult> {
    return this.switchVault((api, session, keys) => vaults.chooseVault(this.o.state, api, session, keys, vaultId));
  }

  /** Creates a new, empty vault on the server and switches this device to it. */
  createVault(name: string): Promise<StartResult> {
    if (name.trim() === '') return Promise.reject(new Error('Give the vault a name.'));
    return this.switchVault((api, session, keys) => vaults.createVault(this.o.state, api, session, keys, name.trim()));
  }

  async devices(): Promise<DeviceInfo[]> {
    return account.listDevices(this.api(await this.session()));
  }

  async removeDevice(deviceId: string): Promise<void> {
    await account.revokeDevice(this.api(await this.session()), deviceId);
  }

  /**
   * The vault switch: no engine may run while the vault state is replaced,
   * so syncing stops for good first; the user's choice then starts it.
   */
  private async switchVault(choose: (api: ApiClient, session: Session, keys: UserKeys) => Promise<unknown>): Promise<StartResult> {
    const session = await this.session();
    const keys = await account.loadUserKeys(this.o.state, session.userId);
    if (!keys) throw new Error('This device is locked. Open the settings again to unlock it.');
    await this.o.shell.stopForGood();
    await choose(this.api(session), session, keys);
    return this.o.shell.start({ byUser: true });
  }

  private api(session: Session): ApiClient {
    return account.apiFor(session, { fetch: this.o.fetch });
  }
}
