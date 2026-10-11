// The plugin's settings tab: the setup steps (SetupController.step decides
// which one is shown), then the day-to-day settings. All logic is in the
// setup controller and the shell controller; this file only builds the
// screens and shows errors.
import { Notice, PluginSettingTab, Setting, type App, type ButtonComponent, type Plugin } from 'obsidian';
import type { FetchLike } from '../api/client';
import { PASSPHRASE_MIN_CHARS, PASSPHRASE_MIN_WORDS } from '../services/account';
import type { LocalState } from '../state/store';
import type { ShellController } from './controller';
import { describeError } from './errors';
import { ConfirmModal, TrashModal } from './history-modal';
import { formatIgnoreText, parseIgnoreText } from './ignore-text';
import { describePlatform } from './platform';
import { SetupController, type RemoteVaults } from './setup-controller';
import type { SetupStep } from './steps';
import { statusLabel } from './status';

const START_FAILURES: Record<Extract<Awaited<ReturnType<ShellController['start']>>, { ok: false }>['reason'], string> = {
  'not-logged-in': 'this device is not signed in.',
  locked: 'this device is locked. Open the settings again to unlock it.',
  'no-vault': 'no vault is chosen for this device.',
  'ignores-unconfirmed': 'the files not to sync are not confirmed yet.',
  stopped: 'sync was stopped.',
};

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
  private readonly setup: SetupController;

  constructor(app: App, plugin: Plugin, private readonly shell: ShellController, state: LocalState, fetch: FetchLike) {
    super(app, plugin);
    this.setup = new SetupController({ state, fetch, shell });
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
      step = await this.setup.step();
    } catch (err) {
      if (token !== this.renderToken) return;
      containerEl.empty();
      const shown = describeError(err);
      containerEl.createEl('p', { text: shown.message });
      this.errorEl = containerEl.createDiv({ cls: 'obsync-error' });
      if (shown.kind === 'login') {
        // The server no longer accepts this device, so the setup steps cannot run: forgetting the account locally is the way back to the sign-in screen.
        new Setting(containerEl).addButton((b) => b.setButtonText('Sign in again').setCta().onClick(this.action(b, async () => {
          await this.shell.logout();
          await this.render();
        })));
      } else {
        new Setting(containerEl).addButton((b) => b.setButtonText('Try again').onClick(() => void this.render()));
      }
      return;
    }
    if (token !== this.renderToken) return;
    containerEl.empty();
    try {
      switch (step.kind) {
        case 'login': this.renderLogin(); break;
        case 'setup-keys': this.renderSetupKeys(step.reupload); break;
        case 'confirm-recovery': this.renderRecovery(step.words); break;
        case 'unlock': this.renderUnlock(); break;
        case 'choose-vault': await this.renderChooseVault(); break;
        case 'confirm-ignores': this.renderConfirmIgnores(); break;
        case 'ready': await this.renderReady(); break;
      }
    } catch (err) {
      if (token !== this.renderToken) return;
      containerEl.createEl('p', { text: describeError(err).message });
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
      await this.setup.login(f.server, f.username, f.password, f.deviceName.trim() || describePlatform().name, describePlatform().platform);
      f.password = '';
      await this.render();
    })));
  }

  private renderSetupKeys(reupload: boolean): void {
    const f = this.form;
    this.heading(reupload ? 'Set the encryption passphrase again' : 'Choose an encryption passphrase');
    this.containerEl.createEl('p', {
      text: reupload
        ? 'The server lost the keys of your account, but this device still has them. Choose a passphrase, different from your account password, to store them again; you will get new recovery words.'
        : 'This passphrase protects your notes. It must be different from your account password: the server sees that password at every sign-in, but never this passphrase. Nobody can reset it for you. You will also get recovery words as a backup.',
    });
    this.containerEl.createEl('p', {
      text: 'A good passphrase is four or more random words, for example picked by rolling dice on a word list (diceware): strong, and easy to remember.',
    });
    this.text('Passphrase', `At least ${PASSPHRASE_MIN_WORDS} words or ${PASSPHRASE_MIN_CHARS} characters.`, () => f.passphrase, (v) => (f.passphrase = v), { secret: true, autocomplete: 'new-password' });
    this.text('Repeat the passphrase', '', () => f.passphrase2, (v) => (f.passphrase2 = v), { secret: true, autocomplete: 'new-password' });
    new Setting(this.containerEl).setDesc('Creating the keys takes a few seconds, longer on a phone.').addButton((b) => b.setButtonText('Create keys').setCta().onClick(this.action(b, async () => {
      const result = await this.setup.setupKeys(f.passphrase, f.passphrase2);
      // Another device finished the setup first: the next screen offers unlocking with its passphrase.
      if ('alreadySetUp' in result) new Notice(`Obsync: ${result.alreadySetUp.message}`, 10000);
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
        await this.setup.acknowledgeRecoveryWords();
        await this.render();
      })));
  }

  private renderUnlock(): void {
    const f = this.form;
    this.heading('Unlock this device');
    this.containerEl.createEl('p', { text: 'Your account already has encryption keys. Enter your passphrase to use them on this device.' });
    this.text('Passphrase', '', () => f.passphrase, (v) => (f.passphrase = v), { secret: true, autocomplete: 'current-password' });
    new Setting(this.containerEl).addButton((b) => b.setButtonText('Unlock').setCta().onClick(this.action(b, async () => {
      await this.setup.unlockWithPassphrase(f.passphrase);
      f.passphrase = '';
      await this.render();
    })));
    new Setting(this.containerEl).setName('Forgot the passphrase?').setDesc('Use the 24 recovery words instead.').addTextArea((a) => {
      a.inputEl.rows = 3;
      a.inputEl.spellcheck = false;
      a.inputEl.setAttr('autocapitalize', 'off');
      a.inputEl.setAttr('autocorrect', 'off');
      a.inputEl.setAttr('autocomplete', 'off');
      a.setPlaceholder('Type or paste the 24 words').onChange((v) => (f.recoveryWords = v));
    }).addButton((b) => b.setButtonText('Unlock with recovery words').onClick(this.action(b, async () => {
      await this.setup.unlockWithRecoveryWords(f.recoveryWords);
      f.recoveryWords = '';
      await this.render();
    })));
  }

  private async renderChooseVault(): Promise<void> {
    const f = this.form;
    let remote: RemoteVaults;
    try {
      remote = await this.setup.remoteVaults();
    } catch (err) {
      this.heading('Choose the vault to sync');
      this.containerEl.createEl('p', { text: 'Files in this vault that are not on the server yet are uploaded. A file that exists on both sides is merged, or both versions are kept.' });
      this.containerEl.createEl('p', { text: describeError(err).message });
      return;
    }
    if (remote.locked) {
      this.containerEl.createEl('p', { text: 'This device is locked. Open the settings again to unlock it.' });
      return;
    }
    this.heading('Choose the vault to sync');
    this.containerEl.createEl('p', { text: 'Files in this vault that are not on the server yet are uploaded. A file that exists on both sides is merged, or both versions are kept.' });
    for (const v of remote.vaults) {
      new Setting(this.containerEl)
        .setName(v.name ?? 'A vault this account cannot read')
        .setDesc(`Created ${new Date(v.createdAtMs).toLocaleDateString()}`)
        .addButton((b) => {
          b.setButtonText('Use this vault').onClick(this.action(b, async () => {
            await this.setup.useVault(v.vaultId);
            await this.render();
          }));
          if (v.name === null) b.setDisabled(true);
        });
    }
    this.text('New vault name', 'Create a new, empty vault on the server for this one.', () => f.vaultName, (v) => (f.vaultName = v));
    new Setting(this.containerEl).addButton((b) => b.setButtonText('Create vault').setCta().onClick(this.action(b, async () => {
      await this.setup.createVault(f.vaultName);
      await this.render();
    })));
  }

  private renderConfirmIgnores(): void {
    this.heading('Choose what not to sync');
    this.containerEl.createEl('p', {
      text: 'Before the first sync, list the files and folders this device should not sync, for example .venv/ or node_modules/. Nothing is uploaded or downloaded until you start.',
    });
    this.ignoreEditor('Start syncing', async (globs, button) => {
      const started = await this.setup.confirmIgnores(globs);
      this.form.ignoreText = null;
      if (!started.ok) {
        const message = `Sync could not start: ${START_FAILURES[started.reason]}`;
        this.errorEl?.setText(message);
        new Notice(`Obsync: ${message}`, 10000);
        button.setDisabled(false);
        return;
      }
      new Notice('Obsync: sync has started.');
      await this.render();
    }, true);
  }

  private async renderReady(): Promise<void> {
    const session = await this.setup.session();
    const vaultName = await this.setup.vaultName();
    this.heading('Sync');
    new Setting(this.containerEl)
      .setName(`Syncing ${vaultName ?? 'your vault'}`)
      .setDesc(`${statusLabel(this.shell.status)}. Signed in as ${session.username} on ${session.deviceName}.`)
      .addButton((b) => b.setButtonText('Sync now').onClick(() => {
        new Notice(this.shell.syncNow() ? 'Obsync: syncing.' : 'Obsync: sync is not running. Use Start to begin.');
      }));
    if (this.shell.status === 'stopped') {
      new Setting(this.containerEl).setName('Sync is not running').addButton((b) => b.setButtonText('Start').setCta().onClick(this.action(b, async () => {
        await this.shell.start({ byUser: true });
        await this.render();
      })));
    }
    await this.renderHeldDeletions();
    this.renderIgnore();
    new Setting(this.containerEl).setName('Deleted files').setDesc('Restore a file that was deleted. To see the earlier versions of a note, use the history command or the note\'s menu.')
      .addButton((b) => b.setButtonText('Show deleted files').onClick(() => new TrashModal(this.app, this.shell).open()));
    await this.renderDevices();
    new Setting(this.containerEl).setName('Sign out').setDesc('Stops syncing and removes the account and its keys from this device. Your files stay.')
      .addButton((b) => b.setButtonText('Sign out').setWarning().onClick(() => {
        new ConfirmModal(this.app, 'Sign out of Obsync on this device? Your files stay. You will need your passphrase or recovery words to sign in again.', 'Sign out', async () => {
          await this.shell.logout();
          await this.render();
        }).open();
      }));
  }

  private async renderHeldDeletions(): Promise<void> {
    const held = await this.shell.heldDeletions();
    if (held.length === 0) return;
    new Setting(this.containerEl).setName('Deletions on hold')
      .setDesc(`${held.length} files deleted on this device are not deleted on your other devices yet. Restore them here, or delete them there too.`)
      .addButton((b) => b.setButtonText('Restore here').setCta().onClick(this.action(b, async () => {
        const n = await this.shell.restoreHeldHere();
        new Notice(`Obsync: restoring ${n} files.`);
        await this.render();
      })))
      .addButton((b) => b.setButtonText('Delete on all devices').setWarning().onClick(() => {
        new ConfirmModal(this.app, `Delete these ${held.length} files on all your devices? The server keeps them in its deleted files for a while.`, 'Delete on all devices', async () => {
          const n = await this.shell.deleteHeldEverywhere();
          new Notice(`Obsync: deleting ${n} files on all devices.`);
          await this.render();
        }).open();
      }));
  }

  private renderIgnore(): void {
    this.ignoreEditor('Save', async (globs, button) => {
      await this.shell.setIgnoreGlobs(globs);
      this.form.ignoreText = null;
      new Notice('Obsync: ignore rules saved.');
      button.setDisabled(false);
    });
  }

  /**
   * The ignore rules as text, and a button that hands valid rules to save;
   * bad lines are listed by their line number instead. cta: the button is
   * the screen's main action.
   */
  private ignoreEditor(buttonText: string, save: (globs: string[], button: ButtonComponent) => Promise<void>, cta = false): void {
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
      .addButton((b) => {
        b.setButtonText(buttonText).onClick(this.action(b, async () => {
          const parsed = parseIgnoreText(f.ignoreText ?? formatIgnoreText(await this.shell.ignoreGlobs()));
          errors.empty();
          if (parsed.errors.length > 0) {
            for (const e of parsed.errors) errors.createDiv({ text: `Line ${e.line}: ${e.text} — ${e.message}` });
            b.setDisabled(false);
            return;
          }
          await save(parsed.globs, b);
        }));
        if (cta) b.setCta();
      });
  }

  private async renderDevices(): Promise<void> {
    this.heading('Devices');
    let devices;
    try {
      devices = await this.setup.devices();
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
          await this.setup.removeDevice(d.deviceId);
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
}
