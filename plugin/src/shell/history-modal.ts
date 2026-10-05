// The history and trash views, and the confirmation they ask for before a restore.
import { Modal, Notice, Setting, type App } from 'obsidian';
import type { HistoryEntry } from '../services/history';
import type { ShellController } from './controller';
import { describeError } from './errors';
import type { HistoryController } from './history-controller';

const when = (ms: number): string => new Date(ms).toLocaleString();

export class ConfirmModal extends Modal {
  constructor(app: App, private readonly message: string, private readonly confirmText: string, private readonly onConfirm: () => Promise<void>) {
    super(app);
  }

  override onOpen(): void {
    this.contentEl.createEl('p', { text: this.message });
    new Setting(this.contentEl)
      .addButton((b) => b.setButtonText(this.confirmText).setCta().onClick(() => {
        this.close();
        void this.onConfirm();
      }))
      .addButton((b) => b.setButtonText('Cancel').onClick(() => this.close()));
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}

/** Restores an entry after asking, and tells the user how it went. */
function askRestore(app: App, shell: ShellController, history: HistoryController, entry: HistoryEntry, label: string): void {
  new ConfirmModal(app, `Restore ${label}? The file will be written to your vault and synced as a new version.`, 'Restore', async () => {
    try {
      const path = await history.restore(entry);
      new Notice(`Obsync: restored ${path}`);
      shell.syncNow();
    } catch (err) {
      new Notice(`Obsync: ${describeError(err).message}`, 10000);
    }
  }).open();
}

/** Every version of one file, newest first, each comparable with the file as it is now and restorable. */
export class HistoryModal extends Modal {
  constructor(app: App, private readonly shell: ShellController, private readonly path: string) {
    super(app);
  }

  override onOpen(): void {
    this.setTitle(`History of ${this.path}`);
    void this.render();
  }

  private async render(): Promise<void> {
    const { contentEl } = this;
    const history = this.shell.history();
    if (!history) {
      contentEl.createEl('p', { text: 'Sync is not running, so the history cannot be loaded.' });
      return;
    }
    contentEl.createEl('p', { text: 'Loading…' });
    let versions: HistoryEntry[];
    try {
      versions = await history.versions(this.path);
    } catch (err) {
      contentEl.empty();
      contentEl.createEl('p', { text: describeError(err).message });
      return;
    }
    contentEl.empty();
    if (versions.length === 0) contentEl.createEl('p', { text: 'The server has no saved versions of this file.' });
    const diffEl = contentEl.createDiv({ cls: 'obsync-diff' });
    for (const entry of versions) {
      const v = entry.version;
      const setting = new Setting(contentEl)
        .setName(when(v.createdAtMs))
        .setDesc(v.deleted ? 'Deleted' : `${v.size} bytes${entry.meta?.deviceName ? ` · from ${entry.meta.deviceName}` : ''}`);
      if (v.deleted || !entry.meta) continue;
      setting.addButton((b) => b.setButtonText('Compare with now').onClick(() => void this.showDiff(history, entry, diffEl)));
      setting.addButton((b) => b.setButtonText('Restore').onClick(() => askRestore(this.app, this.shell, history, entry, `the version from ${when(v.createdAtMs)}`)));
    }
  }

  private async showDiff(history: HistoryController, entry: HistoryEntry, into: HTMLElement): Promise<void> {
    into.empty();
    try {
      const c = await history.compare(entry);
      if (c.kind === 'binary') {
        into.createEl('p', { text: 'This is not a text file, so there is nothing to compare.' });
      } else if (c.lines === null) {
        into.createEl('p', { text: 'This file is too long to compare here.' });
      } else if (c.lines.every((l) => l.kind === 'same')) {
        into.createEl('p', { text: 'This version is the same as the file now.' });
      } else {
        into.createEl('p', { text: 'Changes from this version to the file now:' });
        const pre = into.createEl('pre');
        for (const l of c.lines) pre.createDiv({ cls: `obsync-diff-${l.kind}`, text: `${l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' '} ${l.text}` });
      }
    } catch (err) {
      into.createEl('p', { text: describeError(err).message });
    }
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}

/** Deleted files that can still be restored. */
export class TrashModal extends Modal {
  constructor(app: App, private readonly shell: ShellController) {
    super(app);
  }

  override onOpen(): void {
    this.setTitle('Deleted files');
    void this.render();
  }

  private async render(): Promise<void> {
    const { contentEl } = this;
    const history = this.shell.history();
    if (!history) {
      contentEl.createEl('p', { text: 'Sync is not running, so the deleted files cannot be loaded.' });
      return;
    }
    contentEl.createEl('p', { text: 'Loading…' });
    try {
      const items = await history.trash();
      contentEl.empty();
      if (items.length === 0) contentEl.createEl('p', { text: 'No deleted files can be restored.' });
      for (const item of items) {
        new Setting(contentEl)
          .setName(item.path)
          .setDesc(`Deleted ${when(item.deletedAtMs)}`)
          .addButton((b) => b.setButtonText('Restore').onClick(() => askRestore(this.app, this.shell, history, item.entry, item.path)));
      }
    } catch (err) {
      contentEl.empty();
      contentEl.createEl('p', { text: describeError(err).message });
    }
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}
