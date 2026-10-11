// The history and trash views, and the confirmation they ask for before a restore.
import { Modal, Notice, Setting, type App } from 'obsidian';
import type { HistoryEntry } from '../services/history';
import type { ShellController } from './controller';
import { describeError } from './errors';
import { groupTrash, type HistoryController, type RestoreManyResult, type TrashGroup } from './history-controller';

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
        void this.onConfirm().catch((err: unknown) => new Notice(`Obsync: ${describeError(err).message}`, 10000));
      }))
      .addButton((b) => b.setButtonText('Cancel').onClick(() => this.close()));
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}

/** A large local deletion is on hold: delete the files on every device, restore them here, or decide later (in the settings). */
export class DeletionHoldModal extends Modal {
  constructor(app: App, private readonly shell: ShellController, private readonly count: number) {
    super(app);
  }

  override onOpen(): void {
    this.setTitle('Deletions on hold');
    this.contentEl.createEl('p', {
      text: `${this.count} files were deleted on this device. So that a mistake does not delete them everywhere, they stay on your other devices until you choose. You can also choose later in the Obsync settings.`,
    });
    const run = (fn: () => Promise<number>, done: (n: number) => string) => (): void => {
      this.close();
      void fn().then((n) => new Notice(`Obsync: ${done(n)}`)).catch((err: unknown) => new Notice(`Obsync: ${describeError(err).message}`, 10000));
    };
    new Setting(this.contentEl)
      .addButton((b) => b.setButtonText('Restore here').setCta().onClick(run(() => this.shell.restoreHeldHere(), (n) => `restoring ${n} files.`)))
      .addButton((b) => b.setButtonText('Delete on all devices').setWarning().onClick(run(() => this.shell.deleteHeldEverywhere(), (n) => `deleting ${n} files on all devices.`)))
      .addButton((b) => b.setButtonText('Decide later').onClick(() => this.close()));
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

/** "on Laptop" for a known device, '' for a version that does not say. */
const onDevice = (device: string): string => (device ? ` on ${device}` : '');

/** When a group's deletions happened: one time, or the range. */
function span(g: TrashGroup): string {
  return g.newestMs - g.oldestMs < 60_000 ? when(g.newestMs) : `${when(g.oldestMs)} to ${when(g.newestMs)}`;
}

/**
 * Deleted files that can still be restored, grouped by the device that
 * deleted them and when (history-controller.ts groupTrash). A group of
 * several files can be restored with one confirmation: the undo for a
 * large deletion that reached every device. (One made on this device is
 * held before it spreads: deletion-hold.ts.)
 */
export class TrashModal extends Modal {
  /** The last bulk restore's outcome, shown above the list until the view closes. */
  private result: RestoreManyResult | null = null;

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
      // Restored files stay in the server's trash until the engine has pushed them.
      const restored = new Set(this.result?.restored ?? []);
      const items = (await history.trash()).filter((i) => !restored.has(i.path));
      contentEl.empty();
      if (this.result) this.showResult(this.result);
      if (items.length === 0) {
        contentEl.createEl('p', { text: 'No deleted files can be restored.' });
        return;
      }
      contentEl.createEl('p', { text: 'Grouped by the device that deleted them and when. A group can be restored at once.' });
      for (const g of groupTrash(items)) {
        if (g.items.length > 1) {
          new Setting(contentEl).setHeading()
            .setName(`${g.items.length} files deleted${onDevice(g.device)}`)
            .setDesc(span(g))
            .addButton((b) => b.setButtonText(`Restore all ${g.items.length}`).onClick(() => this.askRestoreGroup(history, g)));
        }
        for (const item of g.items) {
          new Setting(contentEl)
            .setName(item.path)
            .setDesc(`Deleted ${when(item.deletedAtMs)}${onDevice(item.device)}`)
            .addButton((b) => b.setButtonText('Restore').onClick(() => askRestore(this.app, this.shell, history, item.entry, item.path)));
        }
      }
    } catch (err) {
      contentEl.empty();
      contentEl.createEl('p', { text: describeError(err).message });
    }
  }

  private askRestoreGroup(history: HistoryController, g: TrashGroup): void {
    const n = g.items.length;
    new ConfirmModal(this.app,
      `Restore the ${n} files deleted${onDevice(g.device)} (${span(g)})? They are written to your vault and synced to your other devices as new versions. ` +
      'A file that exists again, or whose name is taken here, is skipped and listed.',
      `Restore ${n} files`, async () => {
        const r = await history.restoreMany(g.items);
        if (r.restored.length > 0) this.shell.syncNow();
        const skipped = r.skipped.length > 0 ? `, ${r.skipped.length} skipped` : '';
        new Notice(`Obsync: restored ${r.restored.length} of ${n} files${skipped}${r.stopped ? `. Stopped: ${r.stopped}` : '.'}`, r.skipped.length > 0 || r.stopped ? 10000 : undefined);
        this.result = r;
        this.contentEl.empty();
        await this.render();
      }).open();
  }

  private showResult(r: RestoreManyResult): void {
    const el = this.contentEl.createDiv({ cls: 'obsync-error' });
    if (r.skipped.length > 0) el.createDiv({ text: `Not restored (${r.skipped.length}):` });
    for (const s of r.skipped) el.createDiv({ text: `${s.path}: ${s.reason}` });
    if (r.stopped) el.createDiv({ text: `Stopped after ${r.restored.length + r.skipped.length} files: ${r.stopped} The rest are still listed below.` });
  }

  override onClose(): void {
    this.result = null;
    this.contentEl.empty();
  }
}
