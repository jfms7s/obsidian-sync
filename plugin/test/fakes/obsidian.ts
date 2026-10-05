// A hand-written stand-in for the part of the `obsidian` module the plugin
// shell uses, aliased in vitest.config.ts so shell code runs in Node. It is
// not a copy of Obsidian: it models the behaviours that decide whether the
// shell's vault adapter is right, and it is deliberately stricter than the
// real thing where that catches bugs:
//
// - The "disk" (FakeFs) can be case-insensitive (it keeps the case a name was
//   created with), normalization-insensitive (APFS: NFC and NFD name the
//   same file) and can have coarse mtimes. Its key function never normalizes
//   unless told to, like Linux, so NFD names stay different files there.
// - The vault index only knows non-hidden paths (no segment starting with
//   '.'). Our own Vault API calls update it at once. Changes made behind its
//   back (the DataAdapter, or another program: `outside`) reach it per
//   `index`: 'sync' (at once), 'lagging' (when flushWatcher() runs, like a
//   file watcher that is slow) or 'none' (never, like mobile).
// - Vault API errors follow Obsidian's: create on an existing file, rename
//   onto an existing file (also a case-only rename on a case-insensitive
//   disk, which real Obsidian refuses), a missing parent folder.
// - DataAdapter calls do not create parent folders, as in Obsidian.
import { ManualClock, type Clock } from '../../src/util/clock';

export interface FakeFsOptions {
  caseInsensitive?: boolean;
  /** NFC and NFD spellings are the same file (macOS). */
  normalizationInsensitive?: boolean;
  /** 1 = exact; 1000 = whole seconds; 2000 = FAT. */
  mtimeGranularityMs?: number;
  clock?: Clock;
}

export interface FsEntry {
  /** The name as it was created. */
  path: string;
  kind: 'file' | 'folder';
  data: Uint8Array;
  mtime: number;
  ctime: number;
}

export class FsError extends Error {
  constructor(readonly code: 'ENOENT' | 'EEXIST' | 'ENOTDIR' | 'EISDIR' | 'ENOTEMPTY', path: string) {
    super(`${code}: ${path}`);
    this.name = 'FsError';
  }
}

export class FakeFs {
  private entries = new Map<string, FsEntry>();
  private lastMtime = 0;
  readonly clock: Clock;
  readonly caseInsensitive: boolean;
  readonly normalizationInsensitive: boolean;
  readonly granularity: number;

  constructor(o: FakeFsOptions = {}) {
    this.clock = o.clock ?? new ManualClock(Date.UTC(2026, 0, 1));
    this.caseInsensitive = o.caseInsensitive ?? false;
    this.normalizationInsensitive = o.normalizationInsensitive ?? false;
    this.granularity = o.mtimeGranularityMs ?? 1;
    this.entries.set('', { path: '', kind: 'folder', data: new Uint8Array(0), mtime: 0, ctime: 0 });
  }

  key(path: string): string {
    let k = path;
    if (this.caseInsensitive) k = k.toLowerCase();
    if (this.normalizationInsensitive) k = k.normalize('NFD');
    return k;
  }

  private nextMtime(): number {
    if (this.granularity > 1) return Math.floor(this.clock.now() / this.granularity) * this.granularity;
    this.lastMtime = Math.max(this.clock.now(), this.lastMtime + 1);
    return this.lastMtime;
  }

  get(path: string): FsEntry | undefined {
    return this.entries.get(this.key(path));
  }

  private parentOf(path: string): FsEntry {
    const slash = path.lastIndexOf('/');
    const parent = this.get(slash < 0 ? '' : path.slice(0, slash));
    if (!parent) throw new FsError('ENOENT', path);
    if (parent.kind !== 'folder') throw new FsError('ENOTDIR', path);
    return parent;
  }

  /** Creates the folder and its missing parents; fine if it exists. */
  mkdir(path: string): void {
    const parts = path.split('/').filter((s) => s !== '');
    let cur = '';
    for (const part of parts) {
      cur = cur === '' ? part : `${cur}/${part}`;
      const e = this.get(cur);
      if (e && e.kind === 'file') throw new FsError('ENOTDIR', cur);
      if (!e) {
        const t = this.nextMtime();
        this.entries.set(this.key(cur), { path: cur, kind: 'folder', data: new Uint8Array(0), mtime: t, ctime: t });
      }
    }
  }

  /** Writes a file; its folder must exist. An existing file keeps its name. */
  write(path: string, data: Uint8Array): void {
    this.parentOf(path);
    const prev = this.get(path);
    if (prev?.kind === 'folder') throw new FsError('EISDIR', path);
    const t = this.nextMtime();
    this.entries.set(this.key(path), { path: prev?.path ?? path, kind: 'file', data: data.slice(), mtime: t, ctime: prev?.ctime ?? t });
  }

  read(path: string): Uint8Array {
    const e = this.get(path);
    if (!e) throw new FsError('ENOENT', path);
    if (e.kind === 'folder') throw new FsError('EISDIR', path);
    return e.data.slice();
  }

  children(path: string): FsEntry[] {
    const dir = this.get(path);
    if (!dir) throw new FsError('ENOENT', path);
    if (dir.kind !== 'folder') throw new FsError('ENOTDIR', path);
    const prefix = this.key(dir.path === '' ? '' : `${dir.path}/`);
    const out: FsEntry[] = [];
    for (const [k, e] of this.entries) {
      if (k === '' || !k.startsWith(prefix) || k.slice(prefix.length).includes('/')) continue;
      out.push(e);
    }
    return out.sort((a, b) => (a.path < b.path ? -1 : 1));
  }

  /** The entry and everything below it. */
  subtree(path: string): FsEntry[] {
    const root = this.get(path);
    if (!root) return [];
    const prefix = this.key(`${root.path}/`);
    return [root, ...[...this.entries].filter(([k]) => k.startsWith(prefix)).map(([, e]) => e)];
  }

  remove(path: string): void {
    const e = this.get(path);
    if (!e) throw new FsError('ENOENT', path);
    if (e.kind === 'folder') throw new FsError('EISDIR', path);
    this.entries.delete(this.key(path));
  }

  rmdir(path: string, recursive: boolean): void {
    const e = this.get(path);
    if (!e) throw new FsError('ENOENT', path);
    if (e.kind !== 'folder') throw new FsError('ENOTDIR', path);
    const below = this.subtree(path).slice(1);
    if (below.length > 0 && !recursive) throw new FsError('ENOTEMPTY', path);
    for (const b of below) this.entries.delete(this.key(b.path));
    this.entries.delete(this.key(path));
  }

  /** Stricter than POSIX: never replaces an existing entry. A case-only change of the same entry is fine. */
  rename(oldPath: string, newPath: string): void {
    const e = this.get(oldPath);
    if (!e) throw new FsError('ENOENT', oldPath);
    const same = this.key(oldPath) === this.key(newPath);
    if (!same && this.get(newPath)) throw new FsError('EEXIST', newPath);
    this.parentOf(newPath);
    const moved = this.subtree(oldPath);
    for (const m of moved) this.entries.delete(this.key(m.path));
    for (const m of moved) {
      const renamed = newPath + m.path.slice(e.path.length);
      this.entries.set(this.key(renamed), { ...m, path: renamed }); // a rename keeps mtimes
    }
  }

  /** Test helper: every entry's stored path. */
  paths(): string[] {
    return [...this.entries.values()].filter((e) => e.path !== '').map((e) => e.path).sort();
  }
}

// ---------- the vault ----------

export class TAbstractFile {
  parent: TFolder | null = null;
  constructor(public vault: Vault, public path: string) {}
  get name(): string {
    return this.path.slice(this.path.lastIndexOf('/') + 1);
  }
}

export class TFile extends TAbstractFile {
  stat = { ctime: 0, mtime: 0, size: 0 };
  get extension(): string {
    const dot = this.name.lastIndexOf('.');
    return dot <= 0 ? '' : this.name.slice(dot + 1);
  }
  get basename(): string {
    const dot = this.name.lastIndexOf('.');
    return dot <= 0 ? this.name : this.name.slice(0, dot);
  }
}

export class TFolder extends TAbstractFile {
  children: TAbstractFile[] = [];
  isRoot(): boolean {
    return this.path === '';
  }
}

export interface EventRef {
  name: string;
  fn: (...args: never[]) => unknown;
}

export const hidden = (path: string): boolean => path.split('/').some((s) => s.startsWith('.'));

export interface VaultOptions extends FakeFsOptions {
  /** How the vault index learns of changes made behind its back (see the header). */
  index?: 'sync' | 'lagging' | 'none';
  /** Whether trash(file, true) can use a system trash; otherwise it falls back to .trash/. */
  systemTrash?: boolean;
  /** Whether renaming or deleting a folder also reports every file in it (Obsidian's behaviour is not certain, so both are tested). */
  childEvents?: boolean;
}

type Pending =
  | { type: 'create'; path: string; folder: boolean }
  | { type: 'modify'; path: string; folder: boolean }
  | { type: 'delete'; path: string; folder: boolean }
  | { type: 'rename'; path: string; oldPath: string; folder: boolean };

export class Vault {
  readonly fs: FakeFs;
  readonly adapter: DataAdapter;
  readonly configDir = '.obsidian';
  readonly opts: Required<Pick<VaultOptions, 'index' | 'systemTrash' | 'childEvents'>>;
  /** What the system trash received (path, content). */
  readonly systemTrashed: Array<{ path: string; data: Uint8Array | null }> = [];
  private index = new Map<string, TAbstractFile>();
  private root = new TFolder(this, '');
  private handlers = new Map<string, Array<(...args: never[]) => unknown>>();
  private pending: Pending[] = [];

  constructor(o: VaultOptions = {}) {
    this.fs = new FakeFs(o);
    this.opts = { index: o.index ?? 'sync', systemTrash: o.systemTrash ?? true, childEvents: o.childEvents ?? true };
    this.adapter = new DataAdapter(this);
    this.index.set('', this.root);
  }

  // ----- events -----

  on(name: string, fn: (...args: never[]) => unknown): EventRef {
    const list = this.handlers.get(name) ?? [];
    list.push(fn);
    this.handlers.set(name, list);
    return { name, fn };
  }

  offref(ref: EventRef): void {
    this.handlers.set(ref.name, (this.handlers.get(ref.name) ?? []).filter((f) => f !== ref.fn));
  }

  trigger(name: string, ...args: unknown[]): void {
    for (const fn of [...(this.handlers.get(name) ?? [])]) (fn as (...a: unknown[]) => unknown)(...args);
  }

  // ----- the index -----

  getName(): string {
    return 'FakeVault';
  }

  getRoot(): TFolder {
    return this.root;
  }

  getAbstractFileByPath(path: string): TAbstractFile | null {
    return this.index.get(path) ?? null;
  }

  getFileByPath(path: string): TFile | null {
    const f = this.index.get(path);
    return f instanceof TFile ? f : null;
  }

  getFolderByPath(path: string): TFolder | null {
    const f = this.index.get(path);
    return f instanceof TFolder ? f : null;
  }

  getFiles(): TFile[] {
    return [...this.index.values()].filter((f): f is TFile => f instanceof TFile);
  }

  private indexAdd(path: string, folder: boolean): TAbstractFile | null {
    if (hidden(path) || this.index.has(path)) return this.index.get(path) ?? null;
    const slash = path.lastIndexOf('/');
    const parentPath = slash < 0 ? '' : path.slice(0, slash);
    const parent = (parentPath === '' ? this.root : (this.indexAdd(parentPath, true) as TFolder | null));
    if (!parent) return null;
    const entry = this.fs.get(path);
    if (!entry) return null;
    const node = folder ? new TFolder(this, path) : new TFile(this, path);
    if (node instanceof TFile) node.stat = { ctime: entry.ctime, mtime: entry.mtime, size: entry.data.length };
    node.parent = parent;
    parent.children.push(node);
    this.index.set(path, node);
    return node;
  }

  private indexRemove(path: string): void {
    const node = this.index.get(path);
    if (!node) return;
    if (node instanceof TFolder) for (const c of [...node.children]) this.indexRemove(c.path);
    node.parent?.children.splice(node.parent.children.indexOf(node), 1);
    this.index.delete(path);
  }

  /** Moves an indexed node and everything below it to newPath, keeping the same objects (Obsidian updates a TFile in place). */
  private indexMove(node: TAbstractFile, newPath: string): boolean {
    const oldPath = node.path;
    node.parent?.children.splice(node.parent.children.indexOf(node), 1);
    const rekey = (n: TAbstractFile): void => {
      this.index.delete(n.path);
      n.path = newPath + n.path.slice(oldPath.length);
      if (!hidden(n.path)) this.index.set(n.path, n);
      if (n instanceof TFolder) for (const c of [...n.children]) rekey(c);
    };
    rekey(node);
    if (hidden(newPath)) return false; // it left the index
    const slash = newPath.lastIndexOf('/');
    const parent = slash < 0 ? this.root : (this.indexAdd(newPath.slice(0, slash), true) as TFolder);
    node.parent = parent;
    parent.children.push(node);
    return true;
  }

  private refreshStat(path: string): void {
    const node = this.index.get(path);
    const e = this.fs.get(path);
    if (node instanceof TFile && e) node.stat = { ctime: e.ctime, mtime: e.mtime, size: e.data.length };
  }

  /** Marks a change made behind the index's back; it reaches the index according to opts.index. */
  notifyOutside(p: Pending): void {
    if (this.opts.index === 'none') return;
    this.pending.push(p);
    if (this.opts.index === 'sync') this.flushWatcher();
  }

  /** Lets a lagging file watcher catch up: every queued change reaches the index and its event fires. */
  flushWatcher(): void {
    const queue = this.pending;
    this.pending = [];
    for (const p of queue) {
      if (hidden(p.path)) continue;
      if (p.type === 'create') {
        if (this.fs.get(p.path) && !this.index.has(p.path)) {
          const node = this.indexAdd(p.path, p.folder);
          if (node) this.trigger('create', node);
        }
      } else if (p.type === 'modify') {
        const node = this.index.get(p.path);
        if (node) {
          this.refreshStat(p.path);
          this.trigger('modify', node);
        }
      } else if (p.type === 'delete') {
        const node = this.index.get(p.path);
        if (node) {
          this.indexRemove(p.path);
          this.trigger('delete', node);
        }
      } else {
        // A watcher sees a rename as a delete and a create.
        const old = this.index.get(p.oldPath);
        if (old) {
          this.indexRemove(p.oldPath);
          this.trigger('delete', old);
        }
        if (this.fs.get(p.path)) {
          const node = this.indexAdd(p.path, p.folder);
          if (node) this.trigger('create', node);
        }
      }
    }
  }

  /** Test helper: what restarting Obsidian does, the index is rebuilt from the disk (no events). */
  rescan(): void {
    this.pending = [];
    this.index = new Map([['', this.root]]);
    this.root.children = [];
    for (const e of this.fs.subtree('').slice(1)) if (!hidden(e.path)) this.indexAdd(e.path, e.kind === 'folder');
  }

  // ----- the Vault API (updates the index at once) -----

  private ensureAbsent(path: string, what: 'File' | 'Folder'): void {
    if (this.fs.get(path)) throw new Error(`${what} already exists.`);
  }

  async createBinary(path: string, data: ArrayBuffer): Promise<TFile> {
    this.ensureAbsent(path, 'File');
    this.fs.write(path, new Uint8Array(data));
    const node = this.indexAdd(path, false) as TFile;
    this.trigger('create', node);
    return node;
  }

  async createFolder(path: string): Promise<TFolder> {
    this.ensureAbsent(path, 'Folder');
    this.fs.mkdir(path);
    const node = this.indexAdd(path, true) as TFolder;
    this.trigger('create', node);
    return node;
  }

  async readBinary(file: TFile): Promise<ArrayBuffer> {
    const d = this.fs.read(file.path);
    return d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength) as ArrayBuffer;
  }

  async modifyBinary(file: TFile, data: ArrayBuffer): Promise<void> {
    this.fs.write(file.path, new Uint8Array(data));
    this.refreshStat(file.path);
    this.trigger('modify', file);
  }

  async delete(file: TAbstractFile, force = false): Promise<void> {
    const folder = file instanceof TFolder;
    const kids = folder ? [...this.fs.subtree(file.path).slice(1)] : [];
    if (folder) this.fs.rmdir(file.path, force);
    else this.fs.remove(file.path);
    this.indexRemove(file.path);
    this.announceDelete(file, kids);
  }

  private announceDelete(file: TAbstractFile, kids: FsEntry[]): void {
    if (this.opts.childEvents) for (const k of kids) this.trigger('delete', Object.assign(k.kind === 'folder' ? new TFolder(this, k.path) : new TFile(this, k.path)));
    this.trigger('delete', file);
  }

  async trash(file: TAbstractFile, system: boolean): Promise<void> {
    if (system && this.opts.systemTrash) {
      const folder = file instanceof TFolder;
      this.systemTrashed.push({ path: file.path, data: folder ? null : this.fs.read(file.path) });
      await this.delete(file, true);
      return;
    }
    await this.adapter.trashLocal(file.path);
    this.indexRemove(file.path);
    this.trigger('delete', file);
  }

  async rename(file: TAbstractFile, newPath: string): Promise<void> {
    // Obsidian checks for the destination without regard to case, so even a case-only change is refused.
    if (this.fs.get(newPath)) throw new Error('Destination file already exists!');
    const folder = file instanceof TFolder;
    const oldPath = file.path;
    const kids = folder ? this.fs.subtree(oldPath).slice(1).map((e) => e.path) : [];
    this.fs.rename(oldPath, newPath);
    if (!this.index.has(oldPath)) return; // not indexed (it was hidden or unknown): nothing to move or report
    if (!this.indexMove(file, newPath)) {
      this.trigger('delete', file); // moved to a hidden path: it left the index
      return;
    }
    if (this.opts.childEvents) {
      for (const oldKid of kids) {
        const kid = this.index.get(newPath + oldKid.slice(oldPath.length));
        if (kid) this.trigger('rename', kid, oldKid);
      }
    }
    this.trigger('rename', file, oldPath);
  }
}

export class DataAdapter {
  constructor(private readonly vault: Vault) {}

  getName(): string {
    return 'FakeAdapter';
  }

  async exists(path: string): Promise<boolean> {
    return this.vault.fs.get(path) !== undefined;
  }

  async stat(path: string): Promise<{ type: 'file' | 'folder'; ctime: number; mtime: number; size: number } | null> {
    const e = this.vault.fs.get(path);
    return e ? { type: e.kind, ctime: e.ctime, mtime: e.mtime, size: e.kind === 'file' ? e.data.length : 0 } : null;
  }

  async list(path: string): Promise<{ files: string[]; folders: string[] }> {
    const kids = this.vault.fs.children(path === '/' ? '' : path);
    return { files: kids.filter((k) => k.kind === 'file').map((k) => k.path), folders: kids.filter((k) => k.kind === 'folder').map((k) => k.path) };
  }

  async readBinary(path: string): Promise<ArrayBuffer> {
    const d = this.vault.fs.read(path);
    return d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength) as ArrayBuffer;
  }

  async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
    const existed = this.vault.fs.get(path) !== undefined;
    this.vault.fs.write(path, new Uint8Array(data));
    this.vault.notifyOutside({ type: existed ? 'modify' : 'create', path: this.vault.fs.get(path)!.path, folder: false });
  }

  async mkdir(path: string): Promise<void> {
    const before = new Set(this.vault.fs.paths());
    this.vault.fs.mkdir(path);
    for (const p of this.vault.fs.paths()) if (!before.has(p)) this.vault.notifyOutside({ type: 'create', path: p, folder: true });
  }

  async remove(path: string): Promise<void> {
    const stored = this.vault.fs.get(path)?.path ?? path;
    this.vault.fs.remove(path);
    this.vault.notifyOutside({ type: 'delete', path: stored, folder: false });
  }

  async rmdir(path: string, recursive: boolean): Promise<void> {
    const stored = this.vault.fs.get(path)?.path ?? path;
    this.vault.fs.rmdir(path, recursive);
    this.vault.notifyOutside({ type: 'delete', path: stored, folder: true });
  }

  async rename(path: string, newPath: string): Promise<void> {
    const e = this.vault.fs.get(path);
    this.vault.fs.rename(path, newPath);
    this.vault.notifyOutside({ type: 'rename', path: newPath, oldPath: e?.path ?? path, folder: e?.kind === 'folder' });
  }

  async trashSystem(path: string): Promise<boolean> {
    if (!this.vault.opts.systemTrash) return false;
    const e = this.vault.fs.get(path);
    if (!e) return false;
    this.vault.systemTrashed.push({ path: e.path, data: e.kind === 'file' ? e.data.slice() : null });
    if (e.kind === 'folder') await this.rmdir(path, true);
    else await this.remove(path);
    return true;
  }

  async trashLocal(path: string): Promise<void> {
    const e = this.vault.fs.get(path);
    if (!e) throw new FsError('ENOENT', path);
    this.vault.fs.mkdir('.trash');
    const name = e.path.slice(e.path.lastIndexOf('/') + 1);
    let target = `.trash/${name}`;
    for (let n = 2; this.vault.fs.get(target); n++) target = `.trash/${name} ${n}`;
    const stored = e.path;
    this.vault.fs.rename(path, target);
    this.vault.notifyOutside({ type: 'delete', path: stored, folder: e.kind === 'folder' });
  }
}

/** Test helpers for changes made behind the plugin's back, like another program editing the vault folder. */
export class Outside {
  constructor(private readonly vault: Vault) {}

  write(path: string, data: Uint8Array): void {
    const existed = this.vault.fs.get(path) !== undefined;
    const slash = path.lastIndexOf('/');
    if (slash > 0) this.vault.fs.mkdir(path.slice(0, slash));
    this.vault.fs.write(path, data);
    this.vault.notifyOutside({ type: existed ? 'modify' : 'create', path: this.vault.fs.get(path)!.path, folder: false });
  }

  remove(path: string): void {
    const stored = this.vault.fs.get(path)?.path ?? path;
    this.vault.fs.remove(path);
    this.vault.notifyOutside({ type: 'delete', path: stored, folder: false });
  }
}

// ---------- the rest of the module surface used by the shell ----------

export function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\/+|\/+$/g, '').replace(/ /g, ' ');
}

export const Platform = { isMobile: false, isDesktop: true, isIosApp: false, isAndroidApp: false, isMacOS: false, isWin: false, isLinux: true };

export function requestUrl(): never {
  throw new Error('requestUrl is not available in tests: pass a request function to the transport');
}

// ---------- a minimal UI, enough to drive the plugin's screens in tests ----------

export class FakeEl {
  children: FakeEl[] = [];
  settings: Setting[] = [];
  text = '';
  cls = '';
  attrs: Record<string, string> = {};
  type = '';
  rows = 0;
  spellcheck = true;
  constructor(readonly tag = 'div') {}
  empty(): void {
    this.children = [];
    this.settings = [];
    this.text = '';
  }
  createEl(tag: string, o: { text?: string; cls?: string } = {}): FakeEl {
    const e = new FakeEl(tag);
    e.text = o.text ?? '';
    e.cls = o.cls ?? '';
    this.children.push(e);
    return e;
  }
  createDiv(o: { text?: string; cls?: string } = {}): FakeEl {
    return this.createEl('div', o);
  }
  createSpan(o: { text?: string; cls?: string } = {}): FakeEl {
    return this.createEl('span', o);
  }
  setText(t: string): void {
    this.text = t;
  }
  setAttr(k: string, v: string | number | boolean | null): void {
    this.attrs[k] = String(v);
  }
  addClass(c: string): void {
    this.cls = `${this.cls} ${c}`.trim();
  }
  /** All the text on the element, its children and its settings, for assertions. */
  allText(): string {
    return [this.text, ...this.children.map((c) => c.allText()), ...this.settings.map((s) => [s.name, s.desc, ...s.buttons.map((b) => b.text)].join(' '))].join('\n');
  }
}

export class TextComponent {
  readonly inputEl = new FakeEl('input');
  value = '';
  placeholder = '';
  private handler: ((v: string) => unknown) | null = null;
  setValue(v: string): this {
    this.value = v;
    return this;
  }
  setPlaceholder(p: string): this {
    this.placeholder = p;
    return this;
  }
  onChange(cb: (v: string) => unknown): this {
    this.handler = cb;
    return this;
  }
  /** What the user typing v would do. */
  type(v: string): void {
    this.value = v;
    void this.handler?.(v);
  }
}

export class ButtonComponent {
  text = '';
  cta = false;
  warning = false;
  disabled = false;
  private handler: (() => unknown) | null = null;
  setButtonText(t: string): this {
    this.text = t;
    return this;
  }
  setCta(): this {
    this.cta = true;
    return this;
  }
  setWarning(): this {
    this.warning = true;
    return this;
  }
  setDisabled(d: boolean): this {
    this.disabled = d;
    return this;
  }
  onClick(cb: () => unknown): this {
    this.handler = cb;
    return this;
  }
  /** What the user pressing the button does; resolves when its work is done. */
  async click(): Promise<void> {
    if (this.disabled) return;
    await this.handler?.();
  }
}

export class Setting {
  name = '';
  desc = '';
  heading = false;
  texts: TextComponent[] = [];
  buttons: ButtonComponent[] = [];
  constructor(containerEl: FakeEl) {
    containerEl.settings.push(this);
  }
  setName(n: string): this {
    this.name = n;
    return this;
  }
  setDesc(d: string): this {
    this.desc = d;
    return this;
  }
  setHeading(): this {
    this.heading = true;
    return this;
  }
  addText(cb: (t: TextComponent) => unknown): this {
    const t = new TextComponent();
    this.texts.push(t);
    void cb(t);
    return this;
  }
  addTextArea(cb: (t: TextComponent) => unknown): this {
    return this.addText(cb);
  }
  addButton(cb: (b: ButtonComponent) => unknown): this {
    const b = new ButtonComponent();
    this.buttons.push(b);
    void cb(b);
    return this;
  }
}

export class Notice {
  static shown: Array<{ message: string; timeout?: number }> = [];
  constructor(message: string, timeout?: number) {
    Notice.shown.push(timeout === undefined ? { message } : { message, timeout });
  }
}

export class Modal {
  static opened: Modal[] = [];
  readonly contentEl = new FakeEl();
  title = '';
  constructor(readonly app: App) {}
  setTitle(t: string): this {
    this.title = t;
    return this;
  }
  open(): void {
    Modal.opened.push(this);
    this.onOpen();
  }
  close(): void {
    this.onClose();
  }
  onOpen(): void {}
  onClose(): void {}
}

export class PluginSettingTab {
  readonly containerEl = new FakeEl();
  constructor(readonly app: App, readonly plugin: Plugin) {}
  display(): void {}
  hide(): void {}
}

export class App {
  readonly vault: Vault;
  private storage = new Map<string, unknown>();
  activeFile: TFile | null = null;
  readonly workspace = {
    onLayoutReady: (cb: () => unknown) => void cb(),
    getActiveFile: () => this.activeFile,
    on: (_name: string, _cb: (...args: never[]) => unknown): EventRef => ({ name: _name, fn: _cb }),
  };
  constructor(vault: Vault) {
    this.vault = vault;
  }
  loadLocalStorage(key: string): unknown {
    return this.storage.get(key) ?? null;
  }
  saveLocalStorage(key: string, data: unknown): void {
    this.storage.set(key, data);
  }
}

export interface FakeCommand {
  id: string;
  name: string;
  callback?: () => unknown;
  checkCallback?: (checking: boolean) => boolean | void;
}

export class Plugin {
  manifest = { id: 'obsync', dir: '.obsidian/plugins/obsync', name: 'Obsync', version: '0.0.0' };
  commands: FakeCommand[] = [];
  settingTabs: PluginSettingTab[] = [];
  statusItems: FakeEl[] = [];
  ribbon: Array<{ icon: string; title: string; click: () => unknown }> = [];
  constructor(readonly app: App, manifest?: Partial<Plugin['manifest']>) {
    Object.assign(this.manifest, manifest);
  }
  addCommand(c: FakeCommand): FakeCommand {
    this.commands.push(c);
    return c;
  }
  addSettingTab(t: PluginSettingTab): void {
    this.settingTabs.push(t);
  }
  addStatusBarItem(): FakeEl {
    const e = new FakeEl();
    this.statusItems.push(e);
    return e;
  }
  addRibbonIcon(icon: string, title: string, click: () => unknown): FakeEl {
    this.ribbon.push({ icon, title, click });
    return new FakeEl();
  }
  registerEvent(_ref: EventRef): void {}
}
