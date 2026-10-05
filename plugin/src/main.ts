// The Obsidian plugin entry point: wires the controller to Obsidian (status
// bar, commands, settings tab, notices). Its logic lives in shell/ and the
// engine; nothing here should need a test of its own beyond starting.
import { Notice, Plugin, TFile } from 'obsidian';
import { defaultWebSocketFactory } from './api/hub';
import { LocalState } from './state/store';
import { toHex } from './util/bytes';
import { cryptoRandom } from './util/random';
import { ShellController } from './shell/controller';
import { createEngineLock } from './shell/engine-lock';
import { HistoryModal, TrashModal } from './shell/history-modal';
import { noticeFor } from './shell/notices';
import { ObsidianAdapter } from './shell/obsidian-adapter';
import { ObsyncSettingTab } from './shell/settings-tab';
import { statusLabel } from './shell/status';
import { createRequestUrlTransport } from './shell/transport';

export default class ObsyncPlugin extends Plugin {
  private shell: ShellController | null = null;
  private state: LocalState | null = null;

  /** Obsidian's IndexedDB is shared by every vault, so this vault's state needs a name of its own; local storage is per vault. */
  private instanceKey(): string {
    const saved: unknown = this.app.loadLocalStorage('obsync-instance');
    if (typeof saved === 'string' && saved !== '') return saved;
    const id = toHex(cryptoRandom.bytes(8));
    this.app.saveLocalStorage('obsync-instance', id);
    return id;
  }

  override async onload(): Promise<void> {
    const key = this.instanceKey();
    const state = await LocalState.open(indexedDB, `obsync-${key}`);
    this.state = state;
    const pluginDir = this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
    const adapter = await ObsidianAdapter.create(this.app.vault, pluginDir);
    const fetch = createRequestUrlTransport();
    const shell = new ShellController({
      state, adapter, configDir: this.app.vault.configDir, fetch, webSocket: defaultWebSocketFactory, lock: createEngineLock(`obsync-engine:${key}`),
    });
    this.shell = shell;

    // A phone has no status bar: the ribbon icon and the settings tab show the state there.
    const statusEl = this.addStatusBarItem();
    let setupNeeded = false;
    const showStatus = (): void => {
      const label = setupNeeded ? 'not set up' : statusLabel(shell.status).toLowerCase();
      statusEl.setText(`Obsync: ${label}`);
    };
    showStatus();
    shell.on((e) => {
      if (e.type === 'status') {
        statusEl.setAttr('aria-label', e.detail ?? '');
        showStatus();
      }
      const n = noticeFor(e);
      if (n) new Notice(n.message, n.timeoutMs);
    });

    this.addRibbonIcon('refresh-cw', 'Obsync: sync now', () => shell.syncNow());
    this.addSettingTab(new ObsyncSettingTab(this.app, this, shell, state, fetch));

    this.addCommand({ id: 'sync-now', name: 'Sync now', callback: () => shell.syncNow() });
    this.addCommand({
      id: 'file-history',
      name: 'Show history of the current file',
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || !shell.history()) return false;
        if (!checking) new HistoryModal(this.app, shell, file.path).open();
        return true;
      },
    });
    this.addCommand({
      id: 'restore-deleted',
      name: 'Restore a deleted file',
      checkCallback: (checking) => {
        if (!shell.history()) return false;
        if (!checking) new TrashModal(this.app, shell).open();
        return true;
      },
    });
    this.registerEvent(this.app.workspace.on('file-menu', (menu, file) => {
      if (!(file instanceof TFile) || !shell.history()) return;
      menu.addItem((item) => item.setTitle('Obsync: show history').setIcon('history').onClick(() => new HistoryModal(this.app, shell, file.path).open()));
    }));

    // Not before the layout is ready: until then Obsidian reports every file in the vault as created.
    this.app.workspace.onLayoutReady(() => {
      void shell.start().then((r) => {
        setupNeeded = !r.ok && r.reason !== 'stopped';
        showStatus();
      });
    });
  }

  override onunload(): void {
    const { shell, state } = this;
    this.shell = null;
    this.state = null;
    // Obsidian does not wait for this: the engine lock makes a new instance wait for the old engine instead.
    void shell?.stop().then(() => state?.close());
  }
}
