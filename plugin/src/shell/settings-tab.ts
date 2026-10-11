// The plugin's settings tab: the setup steps (SetupController.step decides
// which one is shown), then the day-to-day settings. All logic is in the
// setup controller and the shell controller; this file only builds the
// screens and shows errors.
import { Notice, PluginSettingTab, Setting, type App, type ButtonComponent, type Plugin, type TextAreaComponent } from 'obsidian';
import type { FetchLike } from '../api/client';
import { PASSPHRASE_MIN_CHARS, PASSPHRASE_MIN_WORDS } from '../services/account';
import type { LocalState } from '../state/store';
import type { SyncStatus } from '../sync/events';
import { systemClock, type Clock, type TimerHandle } from '../util/clock';
import type { NewlyIgnored } from '../sync/server-removal';
import type { ShellController, StartResult } from './controller';
import { describeError } from './errors';
import { formatBytes } from './format-bytes';
import { ConfirmModal, TrashModal } from './history-modal';
import { parseIgnoreFile, VAULT_IGNORE_FILE } from '../vault/ignore';
import { formatIgnoreText, parseIgnoreText } from './ignore-text';
import { describePlatform } from './platform';
import { SetupController, type RemoteVaults, type StorageUsage } from './setup-controller';
import type { SetupStep } from './steps';
import { statusLabel } from './status';

const START_FAILURES: Record<Extract<StartResult, { ok: false }>['reason'], string> = {
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
  vaultIgnoreText: string | null;
}

/** A text area for typed text that is not prose (recovery words, ignore rules): no spell check or autocorrect. */
/** The storage lines are refreshed after a sync cycle at most this often. */
export const USAGE_REFRESH_MS = 60_000;

function plainTextArea(a: TextAreaComponent, rows: number): void {
  a.inputEl.rows = rows;
  a.inputEl.spellcheck = false;
  a.inputEl.setAttr('autocapitalize', 'off');
  a.inputEl.setAttr('autocorrect', 'off');
  a.inputEl.setAttr('autocomplete', 'off');
}

export class ObsyncSettingTab extends PluginSettingTab {
  private readonly form: Form;
  private renderToken = 0;
  private errorEl: HTMLElement | null = null;
  private readonly setup: SetupController;
  /** While the ready view is shown: the storage lines, and the listener that refreshes them. */
  private usageEl: HTMLElement | null = null;
  private stopUsageRefresh: (() => void) | null = null;
  private usageTimer: TimerHandle | null = null;
  private lastUsageFetchMs = Number.NEGATIVE_INFINITY;

  constructor(app: App, plugin: Plugin, private readonly shell: ShellController, state: LocalState, fetch: FetchLike, private readonly clock: Clock = systemClock) {
    super(app, plugin);
    this.setup = new SetupController({ state, fetch, shell });
    this.form = {
      server: '', username: '', password: '', deviceName: describePlatform().name, passphrase: '', passphrase2: '', recoveryWords: '',
      vaultName: app.vault.getName(), ignoreText: null, vaultIgnoreText: null,
    };
  }

  override display(): void {
    void this.render();
  }

  override hide(): void {
    this.renderToken++;
    this.endUsageRefresh();
    this.form.password = this.form.passphrase = this.form.passphrase2 = this.form.recoveryWords = '';
  }

  private async render(): Promise<void> {
    const token = ++this.renderToken;
    this.endUsageRefresh();
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
      plainTextArea(a, 3);
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
    this.containerEl.createEl('p', {
      text: `Rules the vault already keeps in ${VAULT_IGNORE_FILE} apply on every device too: they arrive before anything else and can be edited here once syncing has started.`,
    });
    this.ignoreEditor('Start syncing', async (globs, button) => {
      const started = await this.setup.confirmIgnores(globs);
      this.form.ignoreText = null;
      await this.reportStart(started, button);
    }, true);
  }

  /** After a start the user asked for: say why sync did not start (the button works again), or that it did. */
  private async reportStart(started: StartResult, button: ButtonComponent): Promise<void> {
    if (!started.ok) {
      const message = `Sync could not start: ${START_FAILURES[started.reason]}`;
      this.errorEl?.setText(message);
      new Notice(`Obsync: ${message}`, 10000);
      button.setDisabled(false);
      return;
    }
    new Notice('Obsync: sync has started.');
    await this.render();
  }

  private async renderReady(): Promise<void> {
    const token = this.renderToken;
    // Asked for now, shown once the rest is built: it must not hold the screen up.
    const usage = this.fetchUsage();
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
        await this.reportStart(await this.shell.start({ byUser: true }), b);
      })));
    }
    this.usageEl = this.containerEl.createDiv({ cls: 'obsync-usage' });
    await this.renderHeldDeletions();
    this.renderVaultIgnore();
    this.renderIgnore();
    new Setting(this.containerEl).setName('Deleted files').setDesc('Restore a file that was deleted. To see the earlier versions of a note, use the history command or the note\'s menu.')
      .addButton((b) => b.setButtonText('Show deleted files').onClick(() => new TrashModal(this.app, this.shell).open()));
    await this.renderDevices();
    if (token !== this.renderToken) return;
    this.showUsage(await usage);
    this.startUsageRefresh(token);
    new Setting(this.containerEl).setName('Sign out').setDesc('Stops syncing and removes the account and its keys from this device. Your files stay.')
      .addButton((b) => b.setButtonText('Sign out').setWarning().onClick(() => {
        new ConfirmModal(this.app, 'Sign out of Obsync on this device? Your files stay. You will need your passphrase or recovery words to sign in again.', 'Sign out', async () => {
          await this.shell.logout();
          await this.render();
        }).open();
      }));
  }

  /** The storage figures, or null when the server cannot say (an old server, offline, any failure): the lines are information only. */
  private async fetchUsage(): Promise<StorageUsage | null> {
    this.lastUsageFetchMs = this.clock.now();
    try {
      return await this.setup.storageUsage();
    } catch {
      return null;
    }
  }

  private showUsage(usage: StorageUsage | null): void {
    const el = this.usageEl;
    if (!el) return;
    el.empty();
    if (!usage) return;
    el.createDiv({ text: `Storage: ${formatBytes(usage.usedBytes)} of ${formatBytes(usage.quotaBytes)} used` });
    if (usage.vaultBytes !== null) el.createDiv({ cls: 'setting-item-description', text: `This vault: ${formatBytes(usage.vaultBytes)} (history and trash included)` });
  }

  /**
   * While this ready view is shown, a sync cycle that ends (syncing, then
   * synced) refreshes the storage lines, at most once per USAGE_REFRESH_MS:
   * a cycle sooner than that refreshes them when the time is up.
   */
  private startUsageRefresh(token: number): void {
    let last: SyncStatus = this.shell.status;
    const off = this.shell.on((e) => {
      if (e.type !== 'status') return;
      const ended = last === 'syncing' && e.status === 'synced';
      last = e.status;
      if (!ended || this.usageTimer) return;
      const refresh = () => {
        this.usageTimer = null;
        void this.fetchUsage().then((u) => {
          if (token === this.renderToken) this.showUsage(u);
        });
      };
      const wait = this.lastUsageFetchMs + USAGE_REFRESH_MS - this.clock.now();
      if (wait <= 0) refresh();
      else this.usageTimer = this.clock.setTimeout(refresh, wait);
    });
    this.stopUsageRefresh = () => {
      off();
      if (this.usageTimer) this.clock.clearTimeout(this.usageTimer);
      this.usageTimer = null;
    };
  }

  private endUsageRefresh(): void {
    this.stopUsageRefresh?.();
    this.stopUsageRefresh = null;
    this.usageEl = null;
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

  /**
   * The vault's .obsyncignore, which Obsidian neither lists nor opens (it
   * is a hidden file): on a phone this is the only place to edit it. Lines
   * with unsupported syntax are saved but skipped, and listed below.
   */
  private renderVaultIgnore(): void {
    const f = this.form;
    const skipped = this.containerEl.createDiv({ cls: 'obsync-error' });
    const showSkipped = (text: string): void => {
      skipped.empty();
      for (const r of parseIgnoreFile(text).rejected) skipped.createDiv({ text: `Line ${r.line} is skipped: ${r.pattern} — ${r.why}` });
    };
    const current = async (): Promise<string> => f.vaultIgnoreText ?? (await this.shell.vaultIgnoreText());
    new Setting(this.containerEl).setName('Ignored on every device')
      .setDesc(`Patterns every device of this vault does not sync, in addition to its own list below; saved in ${VAULT_IGNORE_FILE} at the vault root, which syncs like a note. Same syntax as below.`)
      .addTextArea((a) => {
        plainTextArea(a, 4);
        a.onChange((v) => (f.vaultIgnoreText = v));
        void (async () => {
          const text = await current();
          a.setValue(text);
          showSkipped(text);
        })().catch((err: unknown) => skipped.setText(describeError(err).message));
      })
      .addButton((b) => b.setButtonText('Save for every device').onClick(this.action(b, async () => {
        const text = await current();
        const parsed = await this.shell.setVaultIgnoreText(text);
        f.vaultIgnoreText = null;
        showSkipped(text);
        const n = parsed.rejected.length;
        new Notice(n === 0 ? 'Obsync: rules for every device saved.' : `Obsync: rules for every device saved; ${n} ${n === 1 ? 'line is' : 'lines are'} skipped (see the settings).`);
        b.setDisabled(false);
        this.offerServerRemoval(parsed.newlyIgnored);
      })));
  }

  private renderIgnore(): void {
    this.ignoreEditor('Save', async (globs, button) => {
      const newly = await this.shell.setIgnoreGlobs(globs);
      this.form.ignoreText = null;
      new Notice('Obsync: ignore rules saved.');
      button.setDisabled(false);
      this.offerServerRemoval(newly);
    });
  }

  /**
   * New rules match files that are already on the server: they stay there
   * (and on the other devices) unless the user confirms removing them. Only
   * ever offered after the user saved rules here, never for rules that
   * arrive from another device.
   */
  private offerServerRemoval(newly: NewlyIgnored): void {
    const n = newly.paths.length;
    if (n === 0) return;
    const files = n === 1 ? '1 synced file' : `${n} synced files`;
    const examples = newly.paths.slice(0, 5).join(', ') + (n > 5 ? `, and ${n - 5} more` : '');
    new ConfirmModal(this.app,
      `The new rules match ${files} (${formatBytes(newly.bytes)}): ${examples}. This device no longer syncs them, but they stay on the server and on your other devices. ` +
      'Also remove them from the server? Your other devices then move their copies to the trash, unless they ignore these files too, and the server keeps them in its deleted files for a while. This device keeps its copies.',
      'Remove from server', async () => {
        await this.shell.removeFromServer(newly.paths);
        new Notice(`Obsync: removing ${files} from the server.`);
      }).open();
  }

  /**
   * The ignore rules as text, and a button that hands valid rules to save;
   * bad lines are listed by their line number instead. cta: the button is
   * the screen's main action.
   */
  private ignoreEditor(buttonText: string, save: (globs: string[], button: ButtonComponent) => Promise<void>, cta = false): void {
    const f = this.form;
    const errors = this.containerEl.createDiv({ cls: 'obsync-error' });
    new Setting(this.containerEl).setName('Ignored files').setDesc('Patterns of files and folders this device does not sync, one per line. A folder ends with a slash. Lines starting with # are comments. Negation (!) and character classes ([...]) are not supported.')
      .addTextArea((a) => {
        plainTextArea(a, 6);
        a.onChange((v) => (f.ignoreText = v));
        void (async () => {
          a.setValue(f.ignoreText ?? formatIgnoreText(await this.shell.ignoreGlobs()));
        })().catch((err: unknown) => errors.setText(describeError(err).message));
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
