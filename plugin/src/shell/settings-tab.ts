// The plugin's settings tab: the setup steps (nextStep decides which one is
// shown), then the day-to-day settings. All logic is in the services and the
// controller; this file only builds the screens and shows errors.
import { Notice, PluginSettingTab, Setting, type App, type ButtonComponent, type Plugin } from 'obsidian';
import type { FetchLike } from '../api/client';
import * as account from '../services/account';
import { KeysAlreadySetUpError } from '../services/account';
import * as vaults from '../services/vaults';
import type { LocalState, Session } from '../state/store';
import type { ShellController } from './controller';
import { describeError } from './errors';
import { ConfirmModal, TrashModal } from './history-modal';
import { formatIgnoreText, parseIgnoreText } from './ignore-text';
import { describePlatform } from './platform';
import { nextStep, type SetupStep } from './steps';
import { statusLabel } from './status';

export const MIN_PASSPHRASE_LENGTH = 10;

interface Form {
  server: string;
  username: string;
  password: string;
  deviceName: string;
  passphrase: string;
  passphrase2: string;
  recoveryWords: string;
  vaultName: string;
  ignoreText: string | null;
}

export class ObsyncSettingTab extends PluginSettingTab {
  private readonly form: Form;
  private renderToken = 0;
  private errorEl: HTMLElement | null = null;

  constructor(app: App, plugin: Plugin, private readonly shell: ShellController, private readonly state: LocalState, private readonly fetch: FetchLike) {
    super(app, plugin);
    this.form = {
      server: '', username: '', password: '', deviceName: describePlatform().name, passphrase: '', passphrase2: '', recoveryWords: '',
      vaultName: app.vault.getName(), ignoreText: null,
    };
  }

  override display(): void {
    void this.render();
  }

  override hide(): void {
    this.renderToken++;
    this.form.password = this.form.passphrase = this.form.passphrase2 = this.form.recoveryWords = '';
  }

  private async render(): Promise<void> {
    const token = ++this.renderToken;
    const { containerEl } = this;
    containerEl.empty();
    this.errorEl = null;
    containerEl.createEl('p', { text: 'Loading…' });
    let step: SetupStep;
    try {
      step = await nextStep(this.state, { fetch: this.fetch });
    } catch (err) {
      if (token !== this.renderToken) return;
      containerEl.empty();
      containerEl.createEl('p', { text: describeError(err).message });
      new Setting(containerEl).addButton((b) => b.setButtonText('Try again').onClick(() => void this.render()));
      return;
    }
    if (token !== this.renderToken) return;
    containerEl.empty();
    switch (step.kind) {
      case 'login': this.renderLogin(); break;
      case 'setup-keys': this.renderSetupKeys(step.reupload); break;
      case 'confirm-recovery': this.renderRecovery(step.words); break;
      case 'unlock': this.renderUnlock(); break;
      case 'choose-vault': await this.renderChooseVault(); break;
      case 'ready': await this.renderReady(); break;
    }
    if (token !== this.renderToken) return;
    this.errorEl = containerEl.createDiv({ cls: 'obsync-error' });
    this.renderFooter();
  }

  /** Runs an action behind a button: the button is off meanwhile, and a failure is shown instead of thrown. */
  private action(button: ButtonComponent, fn: () => Promise<void>): () => Promise<void> {
    return async () => {
      button.setDisabled(true);
      this.errorEl?.setText('');
      try {
        await fn();
      } catch (err) {
        const message = describeError(err).message;
        this.errorEl?.setText(message);
        new Notice(`Obsync: ${message}`, 10000);
        button.setDisabled(false);
      }
    };
  }

  private heading(text: string): void {
    new Setting(this.containerEl).setName(text).setHeading();
  }

  private text(name: string, desc: string, get: () => string, set: (v: string) => void, opts: { secret?: boolean; placeholder?: string; autocomplete?: string } = {}): void {
    new Setting(this.containerEl).setName(name).setDesc(desc).addText((t) => {
      t.setValue(get()).onChange(set);
      if (opts.placeholder) t.setPlaceholder(opts.placeholder);
      if (opts.secret) t.inputEl.type = 'password';
      t.inputEl.setAttr('autocomplete', opts.autocomplete ?? 'off');
    });
  }

  // ----- setup steps -----

  private renderLogin(): void {
    const f = this.form;
    this.heading('Sign in');
    this.containerEl.createEl('p', { text: 'Obsync keeps this vault in sync through a server you run. Your notes are encrypted on this device before they leave it.' });
    this.text('Server address', 'Starting with https:// (http:// works only for localhost).', () => f.server, (v) => (f.server = v), { placeholder: 'https://sync.example.com' });
    this.text('Username', '', () => f.username, (v) => (f.username = v), { autocomplete: 'username' });
    this.text('Password', 'The account password the server\'s administrator gave you.', () => f.password, (v) => (f.password = v), { secret: true, autocomplete: 'current-password' });
    this.text('Device name', 'Shown in your device list and in the names of conflict copies.', () => f.deviceName, (v) => (f.deviceName = v));
    new Setting(this.containerEl).addButton((b) => b.setButtonText('Sign in').setCta().onClick(this.action(b, async () => {
      await account.login(this.state, f.server, f.username, f.password, f.deviceName.trim() || describePlatform().name, describePlatform().platform, { fetch: this.fetch });
      f.password = '';
      await this.render();
    })));
  }

  private renderSetupKeys(reupload: boolean): void {
    const f = this.form;
    this.heading(reupload ? 'Set the encryption passphrase again' : 'Choose an encryption passphrase');
    this.containerEl.createEl('p', {
      text: reupload
        ? 'The server lost the keys of your account, but this device still has them. Choose a passphrase to store them again; you will get new recovery words.'
        : 'This passphrase protects your notes. It is separate from your account password, and nobody can reset it for you. You will also get recovery words as a backup.',
    });
    this.text('Passphrase', `At least ${MIN_PASSPHRASE_LENGTH} characters.`, () => f.passphrase, (v) => (f.passphrase = v), { secret: true, autocomplete: 'new-password' });
    this.text('Repeat the passphrase', '', () => f.passphrase2, (v) => (f.passphrase2 = v), { secret: true, autocomplete: 'new-password' });
    new Setting(this.containerEl).setDesc('Creating the keys takes a few seconds, longer on a phone.').addButton((b) => b.setButtonText('Create keys').setCta().onClick(this.action(b, async () => {
      if (f.passphrase.length < MIN_PASSPHRASE_LENGTH) throw new Error(`The passphrase must have at least ${MIN_PASSPHRASE_LENGTH} characters.`);
      if (f.passphrase !== f.passphrase2) throw new Error('The two passphrases are not the same.');
      const session = await this.session();
      try {
        const { recoveryWords } = await account.setupKeys(this.state, account.apiFor(session, { fetch: this.fetch }), session, f.passphrase);
        f.recoveryWords = recoveryWords;
      } catch (err) {
        // Another device finished the setup first: unlock with its passphrase instead.
        if (!(err instanceof KeysAlreadySetUpError)) throw err;
        new Notice(`Obsync: ${err.message}`, 10000);
      }
      f.passphrase = f.passphrase2 = '';
      await this.render();
    })));
  }

  private renderRecovery(words: string): void {
    this.heading('Write down your recovery words');
    this.containerEl.createEl('p', { text: 'If you forget your passphrase, these 24 words are the only way back to your notes. Write them down and keep them somewhere safe. They are shown only now.' });
    const grid = this.containerEl.createDiv({ cls: 'obsync-recovery-words' });
    words.split(' ').forEach((w, i) => grid.createSpan({ text: `${i + 1}. ${w}` }));
    new Setting(this.containerEl)
      .addButton((b) => b.setButtonText('Copy words').onClick(async () => {
        try {
          await navigator.clipboard.writeText(words);
          new Notice('Obsync: recovery words copied. Paste them into a safe place and clear the clipboard.');
        } catch {
          new Notice('Obsync: could not copy. Write the words down instead.');
        }
      }))
      .addButton((b) => b.setButtonText('I have saved them').setCta().onClick(this.action(b, async () => {
        await account.acknowledgeRecoveryWords(this.state);
        await this.render();
      })));
  }

  private renderUnlock(): void {
    const f = this.form;
    this.heading('Unlock this device');
    this.containerEl.createEl('p', { text: 'Your account already has encryption keys. Enter your passphrase to use them on this device.' });
    this.text('Passphrase', '', () => f.passphrase, (v) => (f.passphrase = v), { secret: true, autocomplete: 'current-password' });
    new Setting(this.containerEl).addButton((b) => b.setButtonText('Unlock').setCta().onClick(this.action(b, async () => {
      const session = await this.session();
      await account.unlockWithPassphraseService(this.state, account.apiFor(session, { fetch: this.fetch }), session, f.passphrase);
      f.passphrase = '';
      await this.render();
    })));
    new Setting(this.containerEl).setName('Forgot the passphrase?').setDesc('Use the 24 recovery words instead.').addTextArea((a) => {
      a.inputEl.rows = 3;
      a.inputEl.spellcheck = false;
      a.inputEl.setAttr('autocapitalize', 'off');
      a.inputEl.setAttr('autocorrect', 'off');
      a.inputEl.setAttr('autocomplete', 'off');
      a.setPlaceholder('word1 word2 word3 …').onChange((v) => (f.recoveryWords = v));
    }).addButton((b) => b.setButtonText('Unlock with recovery words').onClick(this.action(b, async () => {
      const session = await this.session();
      await account.unlockWithRecoveryService(this.state, account.apiFor(session, { fetch: this.fetch }), session, f.recoveryWords);
      f.recoveryWords = '';
      await this.render();
    })));
  }

  private async renderChooseVault(): Promise<void> {
    const f = this.form;
    const session = await this.session();
    const keys = await account.loadUserKeys(this.state, session.userId);
    const api = account.apiFor(session, { fetch: this.fetch });
    if (!keys) {
      this.containerEl.createEl('p', { text: 'This device is locked. Open the settings again to unlock it.' });
      return;
    }
    this.heading('Choose the vault to sync');
    this.containerEl.createEl('p', { text: 'Files in this vault that are not on the server yet are uploaded. A file that exists on both sides is merged, or both versions are kept.' });
    let remote: vaults.RemoteVaultSummary[];
    try {
      remote = await vaults.listRemoteVaults(api, session, keys);
    } catch (err) {
      this.containerEl.createEl('p', { text: describeError(err).message });
      return;
    }
    const begin = async (): Promise<void> => {
      await this.shell.start();
      new Notice('Obsync: sync has started.');
      await this.render();
    };
    for (const v of remote) {
      new Setting(this.containerEl)
        .setName(v.name ?? 'A vault this account cannot read')
        .setDesc(`Created ${new Date(v.createdAtMs).toLocaleDateString()}`)
        .addButton((b) => {
          b.setButtonText('Use this vault').onClick(this.action(b, async () => {
            await this.shell.stop();
            await vaults.chooseVault(this.state, api, session, keys, v.vaultId);
            await begin();
          }));
          if (v.name === null) b.setDisabled(true);
        });
    }
    this.text('New vault name', 'Create a new, empty vault on the server for this one.', () => f.vaultName, (v) => (f.vaultName = v));
    new Setting(this.containerEl).addButton((b) => b.setButtonText('Create vault').setCta().onClick(this.action(b, async () => {
      if (f.vaultName.trim() === '') throw new Error('Give the vault a name.');
      await this.shell.stop();
      await vaults.createVault(this.state, api, session, keys, f.vaultName.trim());
      await begin();
    })));
  }

  private async renderReady(): Promise<void> {
    const session = await this.session();
    const stored = await this.state.getVault();
    this.heading('Sync');
    new Setting(this.containerEl)
      .setName(`Syncing ${stored?.name ?? 'your vault'}`)
      .setDesc(`${statusLabel(this.shell.status)}. Signed in as ${session.username} on ${session.deviceName}.`)
      .addButton((b) => b.setButtonText('Sync now').onClick(() => {
        this.shell.syncNow();
        new Notice('Obsync: syncing.');
      }));
    if (this.shell.status === 'stopped') {
      new Setting(this.containerEl).setName('Sync is not running').addButton((b) => b.setButtonText('Start').setCta().onClick(this.action(b, async () => {
        await this.shell.start();
        await this.render();
      })));
    }
    this.renderIgnore();
    new Setting(this.containerEl).setName('Deleted files').setDesc('Restore a file that was deleted. To see the earlier versions of a note, use the command "Show history of the current file".')
      .addButton((b) => b.setButtonText('Show deleted files').onClick(() => new TrashModal(this.app, this.shell).open()));
    await this.renderDevices(session);
    new Setting(this.containerEl).setName('Sign out').setDesc('Stops syncing and removes the account and its keys from this device. Your files stay.')
      .addButton((b) => b.setButtonText('Sign out').setWarning().onClick(() => {
        new ConfirmModal(this.app, 'Sign out of Obsync on this device? Your files stay. You will need your passphrase or recovery words to sign in again.', 'Sign out', async () => {
          await this.shell.logout();
          await this.render();
        }).open();
      }));
  }

  private renderIgnore(): void {
    const f = this.form;
    const errors = this.containerEl.createDiv({ cls: 'obsync-error' });
    new Setting(this.containerEl).setName('Ignored files').setDesc('Patterns of files and folders this device does not sync, one per line. A folder ends with a slash. Lines starting with # are comments.')
      .addTextArea(async (a) => {
        a.inputEl.rows = 6;
        a.inputEl.spellcheck = false;
        a.inputEl.setAttr('autocapitalize', 'off');
        a.inputEl.setAttr('autocorrect', 'off');
        a.inputEl.setAttr('autocomplete', 'off');
        a.setValue(f.ignoreText ?? formatIgnoreText(await this.shell.ignoreGlobs())).onChange((v) => (f.ignoreText = v));
      })
      .addButton((b) => b.setButtonText('Save').onClick(this.action(b, async () => {
        const parsed = parseIgnoreText(f.ignoreText ?? formatIgnoreText(await this.shell.ignoreGlobs()));
        errors.empty();
        if (parsed.errors.length > 0) {
          for (const e of parsed.errors) errors.createDiv({ text: `Line ${e.line}: ${e.text} — ${e.message}` });
          b.setDisabled(false);
          return;
        }
        await this.shell.setIgnoreGlobs(parsed.globs);
        f.ignoreText = null;
        new Notice('Obsync: ignore rules saved.');
        b.setDisabled(false);
      })));
  }

  private async renderDevices(session: Session): Promise<void> {
    this.heading('Devices');
    let devices;
    try {
      devices = await account.listDevices(account.apiFor(session, { fetch: this.fetch }));
    } catch (err) {
      this.containerEl.createEl('p', { text: describeError(err).message });
      return;
    }
    for (const d of devices.filter((x) => !x.revoked)) {
      const s = new Setting(this.containerEl)
        .setName(d.current ? `${d.name} (this device)` : d.name)
        .setDesc(`${d.platform} · last seen ${new Date(d.lastSeenAtMs).toLocaleString()}`);
      if (!d.current) {
        s.addButton((b) => b.setButtonText('Remove').setWarning().onClick(this.action(b, async () => {
          await account.revokeDevice(account.apiFor(session, { fetch: this.fetch }), d.deviceId);
          await this.render();
        })));
      }
    }
  }

  private renderFooter(): void {
    this.containerEl.createEl('p', {
      cls: 'obsync-footnote',
      text: 'Your encryption keys are stored in this app\'s local database. Other plugins you install can read them, so install only plugins you trust.',
    });
  }

  private async session(): Promise<Session> {
    const s = await this.state.getSession();
    if (!s) throw new Error('You are not signed in.');
    return s;
  }
}
