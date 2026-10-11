// The engine's VaultAdapter over a plain folder, for obsync-cli (Node only;
// nothing under src/ may import this).
//
// Paths the engine uses are NFC with '/' separators. A disk may store a name
// in NFD (HFS+, files copied from macOS), and on a case-insensitive disk a
// name is stored in the case it was created with, so each operation first
// finds the file under its spelling on disk and reports the stored path back
// (FileStat.path), and never creates a second file next to an NFD one.
//
// Writes go to a temporary file in the same folder and are renamed over the
// target, so neither a crash nor a reader ever sees half a file. Deletions
// move the file into the vault's .trash folder (never synced, the folder
// Obsidian's own "move to Obsidian trash" uses), unless trash is off.
//
// Symbolic links are never followed. A link where a file would be is listed
// (so a note replaced by a link is not taken for deleted) but cannot be
// read, written or removed: the engine reports it as a file that failed. A
// path with '.', '..' or empty segments, or whose folders are reached
// through a link, is refused, so nothing can make the engine read or write
// outside the vault.
import { randomBytes } from 'node:crypto';
import { watch as fsWatch, type FSWatcher, type Stats } from 'node:fs';
import { lstat, mkdir, open, readdir, readFile, realpath, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import type { AdapterEvent, Expect, FileStat, VaultAdapter } from '../src/index';

/** Temporary files of this adapter: hidden, and ignored by the engine's default `*.tmp` rule. */
export const TEMP_PATTERN = /^\.obsync-[0-9a-f]{16}\.tmp$/;
/** A temporary file older than this was left by a crash and is removed when list() comes across it. */
const STALE_TEMP_MS = 60 * 60_000;
const tempName = (): string => `.obsync-${randomBytes(8).toString('hex')}.tmp`;

const TRASH = '.trash';

const fold = (s: string): string => s.normalize('NFC').toLowerCase();
const isAscii = (s: string): boolean => /^[\x00-\x7f]*$/.test(s);
/** The spellings a name can have on disk: as asked (NFC) and NFD. */
function spellings(path: string): string[] {
  const nfd = path.normalize('NFD');
  return isAscii(path) || nfd === path ? [path] : [path, nfd];
}
const baseName = (p: string): string => p.slice(p.lastIndexOf('/') + 1);
const parentOf = (p: string): string => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');

/** Refuses what is not a vault-relative path: a '.', '..' or empty segment, or a leading '/'. */
function checkRelative(path: string): void {
  if (path.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')) throw new Error(`refusing ${JSON.stringify(path)}: not a path inside the vault`);
}

function code(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | null)?.code;
}

async function lstatOrNull(p: string): Promise<Stats | null> {
  try {
    return await lstat(p);
  } catch (err) {
    if (code(err) === 'ENOENT' || code(err) === 'ENOTDIR') return null;
    throw err;
  }
}

const statOf = (path: string, st: Stats): FileStat => ({ path, mtime: Math.floor(st.mtimeMs), size: st.size });

/** A file as last seen: path is the engine's (NFC), disk its spelling on disk. */
interface Known {
  path: string;
  disk: string;
  mtime: number;
  size: number;
}

interface Resolved {
  /** The path as stored on disk, vault-relative. */
  disk: string;
  /** The same path in NFC: what the engine knows the file as. */
  engine: string;
  stat: Stats;
}

export interface FsAdapterOptions {
  /** Move deleted files into <vault>/.trash (default true); false deletes them for good. */
  trash?: boolean;
  /**
   * Folders (vault-relative, NFC) whose changes the watcher need not report:
   * ones the engine ignores anyway, such as .git, so a git operation does
   * not cost a database write per file. list() still lists them.
   */
  unwatched?: (folder: string) => boolean;
  /** The watcher failed (e.g. out of inotify watches); changes made by other programs are then found by reconcile only. */
  onWatchError?: (err: Error) => void;
}

/**
 * Whether the disk under dir is case-insensitive: a probe file is written
 * there and looked for in another case. Node offers no way to ask.
 */
export async function probeCaseInsensitive(dir: string): Promise<boolean> {
  const name = tempName();
  const probe = join(dir, name);
  await writeFile(probe, '', { flag: 'wx' });
  try {
    return (await lstatOrNull(join(dir, name.toUpperCase()))) !== null;
  } finally {
    await unlink(probe).catch(() => undefined);
  }
}

export class FsAdapter implements VaultAdapter {
  private readonly listeners = new Set<(ev: AdapterEvent) => void>();
  /**
   * The files as this adapter last left or saw them (key: NFC path, folded
   * on a case-insensitive disk), kept while someone watches. The watcher
   * reports a change only when the disk differs from this, so the
   * adapter's own changes, already reported, are not reported again.
   */
  private known = new Map<string, Known>();
  private watcher: FSWatcher | null = null;
  private queue: Promise<void> = Promise.resolve();

  private constructor(
    /** The vault folder, with links resolved. */
    readonly root: string,
    readonly caseInsensitive: boolean,
    private readonly options: FsAdapterOptions,
  ) {}

  static async create(root: string, options: FsAdapterOptions = {}): Promise<FsAdapter> {
    const real = await realpath(root);
    if (!(await lstat(real)).isDirectory()) throw new Error(`${root} is not a folder`);
    return new FsAdapter(real, await probeCaseInsensitive(real), options);
  }

  private abs(rel: string): string {
    return rel === '' ? this.root : join(this.root, ...rel.split('/'));
  }

  private key(path: string): string {
    return this.caseInsensitive ? fold(path) : path.normalize('NFC');
  }

  /**
   * Refuses a path whose existing folders are reached through a symbolic
   * link: one leading outside the vault would let the engine read or write
   * elsewhere, one inside it would give a file two names. Folders that do
   * not exist yet are created by this adapter as real folders.
   */
  private async checkInside(rel: string): Promise<void> {
    checkRelative(rel);
    let dir = parentOf(rel);
    for (;;) {
      let real: string;
      try {
        real = await realpath(this.abs(dir));
      } catch (err) {
        if (dir !== '' && (code(err) === 'ENOENT' || code(err) === 'ENOTDIR')) {
          dir = parentOf(dir);
          continue;
        }
        throw err;
      }
      if (this.key(relative(this.root, real).split(sep).join('/')) === this.key(dir)) return;
      throw new Error(`refusing ${rel}: a symbolic link on its way leads elsewhere`);
    }
  }

  /** On a case-insensitive disk, rel spelled as stored (null if it is not there); elsewhere rel itself. */
  private async storedCase(rel: string): Promise<string | null> {
    if (!this.caseInsensitive) return rel;
    const parent = parentOf(rel);
    const want = fold(baseName(rel));
    for (const name of await readdir(this.abs(parent))) {
      if (fold(name) === want) return parent === '' ? name : `${parent}/${name}`;
    }
    return null;
  }

  private async resolve(path: string): Promise<Resolved | null> {
    await this.checkInside(path);
    for (const spelling of spellings(path)) {
      const st = await lstatOrNull(this.abs(spelling));
      if (!st) continue;
      if (st.isSymbolicLink()) throw new Error(`${path} is a symbolic link: links are not synced`);
      if (!st.isFile()) return null;
      const disk = await this.storedCase(spelling);
      if (disk === null) return null;
      return { disk, engine: disk.normalize('NFC'), stat: st };
    }
    return null;
  }

  /** What is at path on disk, under any spelling: null, or its kind and stored spelling. */
  private async entryAt(path: string): Promise<{ disk: string; st: Stats } | null> {
    for (const spelling of spellings(path)) {
      const st = await lstatOrNull(this.abs(spelling));
      if (st) return { disk: (await this.storedCase(spelling)) ?? spelling, st };
    }
    return null;
  }

  /** Whether anything but folders and this adapter's temporary files is below dir (a link counts: removing it would lose it). */
  private async holdsFile(dir: string): Promise<boolean> {
    for (const e of await readdir(this.abs(dir), { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (await this.holdsFile(dir === '' ? e.name : `${dir}/${e.name}`)) return true;
      } else if (!(e.isFile() && TEMP_PATTERN.test(e.name))) {
        return true;
      }
    }
    return false;
  }

  async stat(path: string): Promise<FileStat | null> {
    const r = await this.resolve(path);
    return r ? statOf(r.engine, r.stat) : null;
  }

  async hasFolder(path: string): Promise<boolean> {
    await this.checkInside(path);
    const e = await this.entryAt(path);
    return e !== null && e.st.isDirectory() && (await this.holdsFile(e.disk));
  }

  async read(path: string): Promise<Uint8Array | null> {
    const r = await this.resolve(path);
    if (!r) return null;
    try {
      const buf = await readFile(this.abs(r.disk));
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    } catch (err) {
      // It vanished between the stat and the read: that is "does not exist", anything else is a real error.
      if (code(err) === 'ENOENT') return null;
      throw err;
    }
  }

  /** Every file, hidden ones included; the trash folder is this adapter's own and not part of the vault. */
  async list(skip?: (folder: string) => boolean): Promise<string[]> {
    const out = new Set<string>();
    await this.walk('', (folder) => this.isTrash(folder) || (skip?.(folder) ?? false), out, true);
    // A name on disk in both NFC and NFD is one path for the engine, which
    // reaches the NFC one (as ObsidianAdapter does).
    return [...new Set([...out].map((p) => p.normalize('NFC')))].sort();
  }

  private isTrash(rel: string): boolean {
    return (this.options.trash ?? true) && (rel === TRASH || rel.startsWith(`${TRASH}/`));
  }

  /**
   * Adds the files (and links) below dir to out, spelled as on disk; skip
   * is given folders in NFC. sweep removes temporary files left by a crash.
   */
  private async walk(dir: string, skip: ((folder: string) => boolean) | undefined, out: Set<string>, sweep = false): Promise<void> {
    let entries;
    try {
      entries = await readdir(this.abs(dir), { withFileTypes: true });
    } catch (err) {
      if (dir !== '' && (code(err) === 'ENOENT' || code(err) === 'ENOTDIR')) return; // removed while walking
      throw err;
    }
    for (const e of entries) {
      const rel = dir === '' ? e.name : `${dir}/${e.name}`;
      if (e.isFile() && TEMP_PATTERN.test(e.name)) {
        if (sweep) await this.sweepTemp(rel);
      } else if (e.isFile()) {
        out.add(rel);
      } else if (e.isSymbolicLink()) {
        // Where a file would be (a link to a file, or a broken one); a link to a folder is not entered.
        if (!(await stat(this.abs(rel)).catch(() => null))?.isDirectory()) out.add(rel);
      } else if (e.isDirectory()) {
        if (skip?.(rel.normalize('NFC'))) continue;
        await this.walk(rel, skip, out, sweep);
      }
    }
  }

  private async sweepTemp(rel: string): Promise<void> {
    const st = await lstatOrNull(this.abs(rel));
    if (st && Date.now() - st.mtimeMs > STALE_TEMP_MS) await unlink(this.abs(rel)).catch(() => undefined);
  }

  // ----- changing things -----

  private holds(cur: Resolved | null, expect?: Expect): boolean {
    if (!expect) return true;
    if ('absent' in expect) return cur === null;
    return cur !== null && Math.floor(cur.stat.mtimeMs) === expect.mtime && cur.stat.size === expect.size;
  }

  /**
   * Makes sure the folders above path exist (as spelled on disk where they
   * do) and returns the path to create at. A file where a folder must be is
   * an error, like on any file system.
   */
  private async prepareParent(path: string): Promise<string> {
    const parts = path.split('/');
    const name = parts.pop()!;
    let dir = '';
    let i = 0;
    for (; i < parts.length; i++) {
      const e = await this.entryAt(dir === '' ? parts[i]! : `${dir}/${parts[i]!}`);
      if (!e) break;
      if (!e.st.isDirectory()) throw new Error(`ENOTDIR: something other than a folder is in the way of ${path}`);
      dir = e.disk;
    }
    if (i < parts.length) {
      dir = [dir, ...parts.slice(i)].filter((s) => s !== '').join('/');
      await mkdir(this.abs(dir), { recursive: true });
    }
    return dir === '' ? name : `${dir}/${name}`;
  }

  /**
   * An empty folder (no files at any depth) where a file is to go is
   * removed; one with files is an error, and so is a link. Returns the
   * folder removed (as spelled on disk), or null, so a failed write or
   * rename can put it back.
   */
  private async clearFolderAt(path: string): Promise<string | null> {
    const e = await this.entryAt(path);
    if (!e) return null;
    if (e.st.isSymbolicLink()) throw new Error(`refusing to replace the symbolic link ${path}`);
    if (!e.st.isDirectory()) throw new Error(`refusing to replace ${path}, which is not a file`);
    if (await this.holdsFile(e.disk)) throw new Error(`EISDIR: ${path} is a folder`);
    await rm(this.abs(e.disk), { recursive: true });
    return e.disk;
  }

  private async replacingFolder<T>(path: string, move: () => Promise<T>): Promise<T> {
    const removed = await this.clearFolderAt(path);
    try {
      return await move();
    } catch (err) {
      if (removed !== null) await mkdir(this.abs(removed), { recursive: true }).catch(() => undefined);
      throw err;
    }
  }

  /** Writes data to a temporary file next to target and renames it over target (keeping target's mode). */
  private async writeAtomic(target: string, data: Uint8Array, mode?: number): Promise<void> {
    const tmp = join(dirname(this.abs(target)), tempName());
    const fh = await open(tmp, 'wx', 0o666);
    try {
      try {
        await fh.writeFile(data);
        if (mode !== undefined) await fh.chmod(mode & 0o7777);
        await fh.sync();
      } finally {
        await fh.close();
      }
      await rename(tmp, this.abs(target));
    } catch (err) {
      await unlink(tmp).catch(() => undefined);
      throw err;
    }
    // The rename itself survives a power cut only once the folder is on disk.
    const dir = await open(dirname(this.abs(target)), 'r');
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
  }

  write(path: string, data: Uint8Array, expect?: Expect): Promise<boolean> {
    return this.exclusive(() => this.writeNow(path, data, expect));
  }

  private async writeNow(path: string, data: Uint8Array, expect?: Expect): Promise<boolean> {
    const cur = await this.resolve(path);
    if (!this.holds(cur, expect)) return false;
    if (cur) {
      await this.writeAtomic(cur.disk, data, cur.stat.mode);
      await this.remember(cur.disk);
      this.emit({ type: 'modify', path: cur.engine });
      return true;
    }
    const target = await this.replacingFolder(path, async () => {
      const t = await this.prepareParent(path);
      await this.writeAtomic(t, data);
      return t;
    });
    await this.remember(target);
    this.emit({ type: 'create', path: target.normalize('NFC') });
    return true;
  }

  remove(path: string, expect?: Expect): Promise<boolean> {
    return this.exclusive(() => this.removeNow(path, expect));
  }

  private async removeNow(path: string, expect?: Expect): Promise<boolean> {
    const cur = await this.resolve(path);
    if (!this.holds(cur, expect)) return false;
    if (!cur) return true;
    if (this.options.trash ?? true) await this.moveToTrash(cur.disk);
    else await unlink(this.abs(cur.disk));
    this.forget(cur.disk);
    this.emit({ type: 'delete', path: cur.engine });
    return true;
  }

  /** Moves a file to .trash/<its path>, under a new name if one is there already. */
  private async moveToTrash(disk: string): Promise<void> {
    const dest = `${TRASH}/${disk}`;
    await this.checkInside(dest); // a .trash that is a link to elsewhere would carry the file out of the vault
    await mkdir(dirname(this.abs(dest)), { recursive: true });
    await this.checkInside(dest);
    let target = dest;
    for (let n = 1; await lstatOrNull(this.abs(target)); n++) {
      const dot = baseName(dest).lastIndexOf('.');
      const at = dot > 0 ? dest.length - baseName(dest).length + dot : dest.length;
      target = `${dest.slice(0, at)} ${n}${dest.slice(at)}`;
    }
    await rename(this.abs(disk), this.abs(target));
  }

  rename(oldPath: string, newPath: string, expect?: Expect): Promise<boolean> {
    return this.exclusive(() => this.renameNow(oldPath, newPath, expect));
  }

  private async renameNow(oldPath: string, newPath: string, expect?: Expect): Promise<boolean> {
    const cur = await this.resolve(oldPath);
    if (!cur || !this.holds(cur, expect)) return false;
    if (oldPath === newPath) return true;
    await this.checkInside(newPath);
    const target = await this.resolve(newPath);
    let to: string;
    if (target && this.isSameFile(cur, target)) {
      // The same file under another case (or normalization): rename the name in place.
      const slash = cur.disk.lastIndexOf('/');
      to = slash < 0 ? baseName(newPath) : `${cur.disk.slice(0, slash)}/${baseName(newPath)}`;
      await rename(this.abs(cur.disk), this.abs(to));
    } else {
      if (target) return false; // another file is in the way
      to = await this.replacingFolder(newPath, async () => {
        const t = await this.prepareParent(newPath);
        await rename(this.abs(cur.disk), this.abs(t));
        return t;
      });
    }
    this.forget(cur.disk);
    await this.remember(to);
    this.emit({ type: 'rename', path: to.normalize('NFC'), oldPath: cur.engine });
    return true;
  }

  private isSameFile(cur: Resolved, target: Resolved): boolean {
    if (target.disk === cur.disk) return true;
    return this.caseInsensitive ? fold(target.disk) === fold(cur.disk) : target.engine === cur.engine;
  }

  // ----- events -----

  private emit(ev: AdapterEvent): void {
    for (const l of [...this.listeners]) l(ev);
  }

  private async remember(disk: string): Promise<void> {
    if (!this.watcher) return;
    const st = await lstatOrNull(this.abs(disk));
    if (st?.isFile() || st?.isSymbolicLink()) this.known.set(this.key(disk), { path: disk.normalize('NFC'), disk, mtime: Math.floor(st.mtimeMs), size: st.size });
  }

  private forget(disk: string): void {
    this.known.delete(this.key(disk));
  }

  /**
   * Subscribes to changes: the adapter's own, reported as it makes them,
   * and other programs', found by a recursive fs.watch on the vault folder.
   * Another program's rename is reported as a delete and a create.
   */
  watch(listener: (ev: AdapterEvent) => void): () => void {
    this.listeners.add(listener);
    if (this.listeners.size === 1) this.startWatcher();
    return () => {
      if (!this.listeners.delete(listener) || this.listeners.size > 0) return;
      this.watcher?.close();
      this.watcher = null;
      this.known.clear();
    };
  }

  private startWatcher(): void {
    const watcher = fsWatch(this.root, { recursive: true, persistent: false }, (_type, name) => {
      if (name === null) {
        this.enqueue(() => this.rescan(''));
        return;
      }
      const rel = name.split(sep).join('/');
      this.enqueue(() => this.check(rel));
    });
    watcher.on('error', (err) => this.options.onWatchError?.(err));
    this.watcher = watcher;
    this.enqueue(async () => {
      const files = new Set<string>();
      await this.walk('', (folder) => this.walkSkip(folder), files);
      for (const p of files) await this.remember(p);
    });
  }

  private enqueue(job: () => Promise<void>): void {
    this.queue = this.queue.then(job).catch((err: unknown) => {
      this.options.onWatchError?.(err instanceof Error ? err : new Error(String(err)));
    });
  }

  /**
   * Runs one of the adapter's own changes in the watcher's queue: the
   * watcher's look at the paths it touched comes after it, when known
   * already holds the result, so the change is reported once (by the
   * change itself) and never as another program's.
   */
  private exclusive<T>(op: () => Promise<T>): Promise<T> {
    const result = this.queue.then(op);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  /** Resolves once every change the watcher has been told of so far has been looked at. */
  async flushEvents(): Promise<void> {
    await this.queue;
  }

  private ignored(rel: string): boolean {
    if (TEMP_PATTERN.test(baseName(rel))) return true;
    const nfc = rel.normalize('NFC');
    if (this.isTrash(nfc)) return true;
    const skip = this.options.unwatched;
    if (!skip) return false;
    for (let dir = parentOf(nfc); dir !== ''; dir = parentOf(dir)) if (skip(dir)) return true;
    return skip(nfc); // the folder itself
  }

  private walkSkip(folder: string): boolean {
    return this.isTrash(folder) || (this.options.unwatched?.(folder) ?? false);
  }

  /** Compares what is at rel with what was known and reports the difference. */
  private async check(rel: string): Promise<void> {
    if (!this.watcher || this.ignored(rel)) return;
    const st = await lstatOrNull(this.abs(rel));
    if (st?.isDirectory()) {
      await this.rescan(rel);
      return;
    }
    const k = this.key(rel);
    const was = this.known.get(k);
    if (st?.isFile() || st?.isSymbolicLink()) {
      const now = { path: rel.normalize('NFC'), disk: rel, mtime: Math.floor(st.mtimeMs), size: st.size };
      if (was && was.mtime === now.mtime && was.size === now.size) return;
      this.known.set(k, now);
      this.emit({ type: was ? 'modify' : 'create', path: was?.path ?? now.path });
      return;
    }
    if (was) {
      this.known.delete(k);
      this.emit({ type: 'delete', path: was.path });
      return;
    }
    // A folder that was there and is gone: every file known below it went with it.
    await this.rescan(rel, true);
  }

  /** Reports files under dir that appeared, changed or vanished (onlyGone: just the vanished ones). */
  private async rescan(dir: string, onlyGone = false): Promise<void> {
    const prefix = dir === '' ? '' : `${this.key(dir)}/`;
    const present = new Set<string>();
    if (!onlyGone) {
      const files = new Set<string>();
      await this.walk(dir, (folder) => this.walkSkip(folder), files).catch(() => undefined);
      for (const p of files) {
        present.add(this.key(p));
        await this.check(p);
      }
    }
    for (const [k, was] of [...this.known]) {
      if (!k.startsWith(prefix) || present.has(k)) continue;
      if (await lstatOrNull(this.abs(was.disk))) continue;
      this.known.delete(k);
      this.emit({ type: 'delete', path: was.path });
    }
  }
}
