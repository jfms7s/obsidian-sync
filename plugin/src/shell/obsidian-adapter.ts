// The engine's VaultAdapter over Obsidian's Vault and DataAdapter.
//
// Two layers exist in Obsidian. The Vault API (create, modify, trash,
// rename) works on indexed files only, keeps Obsidian's index, open editors
// and link updates right, and fires events. The DataAdapter works on the disk
// and sees everything, including hidden files (a segment starting with '.')
// that the index never holds and files the index has not caught up with yet
// (a watcher that lags, or no watcher at all on mobile). This adapter uses
// the Vault API whenever the file is indexed and falls back to the
// DataAdapter otherwise, and it never trusts the index to say what exists:
// existence, size and mtime always come from the disk.
//
// Paths the engine uses are NFC with '/' separators. A disk may store a name
// in NFD (HFS+, files copied from other systems), and on a case-insensitive
// disk a name is stored in the case it was created with, so each operation
// first finds the file under its spelling on disk and reports the stored
// path back (FileStat.path), and never creates a second file next to an NFD
// one.
import { TFile, TFolder, type EventRef, type Stat, type TAbstractFile, type Vault } from 'obsidian';
import type { AdapterEvent, Expect, FileStat, VaultAdapter } from '../vault/adapter';

/** A renamed file waits under this suffix between the two steps of a case-only rename; recover() finishes an interrupted one. */
export const TEMP_SUFFIX = '.obsync.tmp';

const hidden = (path: string): boolean => path.split('/').some((s) => s.startsWith('.'));
const fold = (s: string): string => s.normalize('NFC').toLowerCase();
const isAscii = (s: string): boolean => /^[\x00-\x7f]*$/.test(s); // eslint-disable-line no-control-regex

/** The spellings a name can have on disk: as asked (NFC) and NFD. */
function spellings(path: string): string[] {
  const nfd = path.normalize('NFD');
  return isAscii(path) || nfd === path ? [path] : [path, nfd];
}

/** A copy of the bytes as an ArrayBuffer of exactly their length (never the backing buffer of a view). */
function toArrayBuffer(data: Uint8Array): ArrayBuffer {
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
}

interface Resolved {
  /** The path as stored on disk: use it for DataAdapter and Vault calls. */
  disk: string;
  /** The same path in NFC: what the engine knows the file as. */
  engine: string;
  stat: Stat;
  /** The indexed file, or null for a hidden one or one the index does not know (yet). */
  file: TFile | null;
}

/**
 * Whether the disk under the vault is case-insensitive, found by writing a
 * probe into a folder the plugin owns (plugin data folder) and looking for
 * it under another case. Obsidian offers no way to ask.
 */
export async function probeCaseInsensitive(vault: Vault, probeDir: string): Promise<boolean> {
  const a = vault.adapter;
  if (!(await a.exists(probeDir))) await a.mkdir(probeDir);
  const probe = `${probeDir}/Case-Probe${TEMP_SUFFIX}`;
  await a.writeBinary(probe, new ArrayBuffer(1));
  try {
    return await a.exists(`${probeDir}/case-probe${TEMP_SUFFIX}`);
  } finally {
    await a.remove(probe).catch(() => undefined);
  }
}

export class ObsidianAdapter implements VaultAdapter {
  private constructor(private readonly vault: Vault, readonly caseInsensitive: boolean) {}

  /** probeDir: a folder this plugin owns, for detecting the disk's case sensitivity. */
  static async create(vault: Vault, probeDir: string): Promise<ObsidianAdapter> {
    return new ObsidianAdapter(vault, await probeCaseInsensitive(vault, probeDir));
  }

  // ----- finding things on disk -----

  /** On a case-insensitive disk, path spelled as stored (null if it is not there); elsewhere path itself. */
  private async storedCase(path: string): Promise<string | null> {
    if (!this.caseInsensitive) return path;
    const indexed = this.vault.getAbstractFileByPath(path);
    if (indexed && indexed.path === path) return path;
    const slash = path.lastIndexOf('/');
    const parent = slash < 0 ? '/' : path.slice(0, slash);
    const want = fold(path.slice(slash + 1));
    const listing = await this.vault.adapter.list(parent);
    for (const full of [...listing.files, ...listing.folders]) {
      if (fold(full.slice(full.lastIndexOf('/') + 1)) === want) return full;
    }
    return null;
  }

  private async resolve(path: string): Promise<Resolved | null> {
    for (const spelling of spellings(path)) {
      const stat = await this.vault.adapter.stat(spelling);
      if (!stat) continue;
      if (stat.type !== 'file') return null;
      const disk = await this.storedCase(spelling);
      if (disk === null) return null;
      const file = hidden(disk) ? null : this.vault.getFileByPath(disk) ?? this.vault.getFileByPath(disk.normalize('NFD'));
      return { disk, engine: disk.normalize('NFC'), stat, file };
    }
    return null;
  }

  /** The folder at path (as spelled on disk), or null. */
  private async folderAt(path: string): Promise<string | null> {
    for (const spelling of spellings(path)) {
      const stat = await this.vault.adapter.stat(spelling);
      if (stat?.type === 'folder') return spelling;
      if (stat) return null;
    }
    return null;
  }

  private async holdsFile(dir: string): Promise<boolean> {
    const listing = await this.vault.adapter.list(dir);
    if (listing.files.length > 0) return true;
    for (const sub of listing.folders) if (await this.holdsFile(sub)) return true;
    return false;
  }

  async stat(path: string): Promise<FileStat | null> {
    const r = await this.resolve(path);
    return r ? { path: r.engine, mtime: r.stat.mtime, size: r.stat.size } : null;
  }

  async hasFolder(path: string): Promise<boolean> {
    const dir = await this.folderAt(path);
    return dir !== null && (await this.holdsFile(dir));
  }

  async read(path: string): Promise<Uint8Array | null> {
    const r = await this.resolve(path);
    if (!r) return null;
    try {
      return new Uint8Array(r.file ? await this.vault.readBinary(r.file) : await this.vault.adapter.readBinary(r.disk));
    } catch (err) {
      // It vanished between the stat and the read: that is "does not exist", anything else is a real error.
      if (!(await this.resolve(path))) return null;
      throw err;
    }
  }

  async list(skip?: (folder: string) => boolean): Promise<string[]> {
    const out = new Set<string>();
    await this.walk('/', skip, out);
    return [...out].sort();
  }

  private async walk(dir: string, skip: ((folder: string) => boolean) | undefined, out: Set<string>): Promise<void> {
    const listing = await this.vault.adapter.list(dir);
    for (const f of listing.files) {
      if (f.endsWith(TEMP_SUFFIX)) {
        const recovered = await this.recoverTemp(f);
        if (recovered !== null) {
          out.add(recovered.normalize('NFC'));
          continue;
        }
      }
      out.add(f.normalize('NFC'));
    }
    for (const sub of listing.folders) {
      if (skip?.(sub.normalize('NFC'))) continue;
      await this.walk(sub, skip, out);
    }
  }

  /** Finishes a case-only rename that was interrupted between its two steps; null if f is not one (or its target is taken). */
  private async recoverTemp(f: string): Promise<string | null> {
    const target = f.slice(0, -TEMP_SUFFIX.length);
    // Another program's *.obsync.tmp is not ours to touch, and the probe file is deleted by its owner.
    if (target === '' || (await this.vault.adapter.exists(target))) return null;
    const stat = await this.vault.adapter.stat(f);
    if (stat?.type !== 'file') return null;
    try {
      await this.vault.adapter.rename(f, target);
    } catch {
      return null;
    }
    return target;
  }

  // ----- changing things -----

  private holds(cur: Resolved | null, expect?: Expect): boolean {
    if (!expect) return true;
    if ('absent' in expect) return cur === null;
    return cur !== null && cur.stat.mtime === expect.mtime && cur.stat.size === expect.size;
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
      let found: string | null = null;
      for (const s of spellings(parts[i]!)) {
        const candidate = dir === '' ? s : `${dir}/${s}`;
        const stat = await this.vault.adapter.stat(candidate);
        if (stat?.type === 'file') throw new Error(`ENOTDIR: a file is in the way of ${path}`);
        if (stat) {
          found = (await this.storedCase(candidate)) ?? candidate;
          break;
        }
      }
      if (found === null) break;
      dir = found;
    }
    for (; i < parts.length; i++) {
      dir = dir === '' ? parts[i]! : `${dir}/${parts[i]!}`;
      await this.makeFolder(dir);
    }
    return dir === '' ? name : `${dir}/${name}`;
  }

  private async makeFolder(dir: string): Promise<void> {
    try {
      if (hidden(dir)) await this.vault.adapter.mkdir(dir);
      else await this.vault.createFolder(dir);
    } catch (err) {
      // Created meanwhile, or on disk and not indexed yet.
      if (!(await this.folderAt(dir))) throw err;
    }
  }

  /** An empty folder (no files at any depth) where a file is to go is replaced; one with files is an error. */
  private async clearFolderAt(path: string): Promise<void> {
    const dir = await this.folderAt(path);
    if (dir === null) return;
    if (await this.holdsFile(dir)) throw new Error(`EISDIR: ${path} is a folder`);
    const folder = hidden(dir) ? null : this.vault.getFolderByPath(dir);
    if (folder) await this.vault.delete(folder, true);
    else await this.vault.adapter.rmdir(dir, true);
  }

  async write(path: string, data: Uint8Array, expect?: Expect): Promise<boolean> {
    const cur = await this.resolve(path);
    if (!this.holds(cur, expect)) return false;
    const buf = toArrayBuffer(data);
    if (cur) {
      if (cur.file) await this.vault.modifyBinary(cur.file, buf);
      else await this.vault.adapter.writeBinary(cur.disk, buf);
      return true;
    }
    await this.clearFolderAt(path);
    const target = await this.prepareParent(path);
    if (hidden(target)) {
      await this.vault.adapter.writeBinary(target, buf);
      return true;
    }
    try {
      await this.vault.createBinary(target, buf);
    } catch (err) {
      // The file exists on disk but the index has not caught up: write through the disk.
      if (!(await this.vault.adapter.exists(target))) throw err;
      await this.vault.adapter.writeBinary(target, buf);
    }
    return true;
  }

  async remove(path: string, expect?: Expect): Promise<boolean> {
    const cur = await this.resolve(path);
    if (!this.holds(cur, expect)) return false;
    if (!cur) return true;
    // Never a permanent delete: the system trash, or Obsidian's .trash folder when there is none.
    if (cur.file) await this.vault.trash(cur.file, true);
    else if (!(await this.vault.adapter.trashSystem(cur.disk))) await this.vault.adapter.trashLocal(cur.disk);
    return true;
  }

  async rename(oldPath: string, newPath: string, expect?: Expect): Promise<boolean> {
    const cur = await this.resolve(oldPath);
    if (!cur || !this.holds(cur, expect)) return false;
    const target = await this.resolve(newPath);
    // The same file under another case (or normalization) is a rename in place; any other file in the way refuses it.
    const sameFile = target !== null && (target.disk === cur.disk || fold(target.disk) === fold(cur.disk));
    if (target && !sameFile) return false;
    if (!sameFile) await this.clearFolderAt(newPath);
    const to = sameFile ? this.sameFileTarget(cur.disk, newPath) : await this.prepareParent(newPath);
    if (cur.file) {
      try {
        await this.vault.rename(cur.file, to);
      } catch (err) {
        if (!sameFile) throw err;
        await this.caseOnlyRename(cur, to); // Obsidian refuses a change of case on a case-insensitive disk
      }
    } else {
      if (sameFile) await this.vault.adapter.rename(cur.disk, `${to}${TEMP_SUFFIX}`);
      await this.vault.adapter.rename(sameFile ? `${to}${TEMP_SUFFIX}` : cur.disk, to);
    }
    return true;
  }

  /** The folder part stays as it is on disk; only the file name (its case or normalization) changes. */
  private sameFileTarget(disk: string, newPath: string): string {
    const slash = disk.lastIndexOf('/');
    const name = newPath.slice(newPath.lastIndexOf('/') + 1);
    return slash < 0 ? name : `${disk.slice(0, slash)}/${name}`;
  }

  /**
   * old → old.obsync.tmp → new, two renames so that neither is a case-only
   * change. A crash in between leaves the file at the temp name, where
   * list() (and so the next reconcile) renames it to its final name.
   */
  private async caseOnlyRename(cur: Resolved, to: string): Promise<void> {
    const tmp = `${to}${TEMP_SUFFIX}`;
    await this.vault.rename(cur.file!, tmp);
    await this.vault.rename(cur.file!, to);
  }

  // ----- events -----

  /**
   * Reports the Vault's events as one event per file. Obsidian may or may
   * not also report the files inside a deleted or renamed folder, so a
   * folder event is expanded from the files this adapter knows of; if
   * Obsidian reports them as well, the engine merely marks a path dirty
   * twice. Events for hidden or not yet indexed files do not exist: those
   * are found by reconcile.
   */
  watch(listener: (ev: AdapterEvent) => void): () => void {
    const known = new Set(this.vault.getFiles().map((f) => f.path));
    const nfc = (p: string) => p.normalize('NFC');
    const under = (dir: string) => [...known].filter((p) => p.startsWith(`${dir}/`));
    const refs: EventRef[] = [
      this.vault.on('create', (f: TAbstractFile) => {
        if (!(f instanceof TFile)) return;
        known.add(f.path);
        listener({ type: 'create', path: nfc(f.path) });
      }),
      this.vault.on('modify', (f: TAbstractFile) => {
        if (!(f instanceof TFile)) return;
        known.add(f.path);
        listener({ type: 'modify', path: nfc(f.path) });
      }),
      this.vault.on('delete', (f: TAbstractFile) => {
        if (f instanceof TFile) {
          known.delete(f.path);
          listener({ type: 'delete', path: nfc(f.path) });
        } else {
          for (const p of under(f.path)) {
            known.delete(p);
            listener({ type: 'delete', path: nfc(p) });
          }
        }
      }),
      this.vault.on('rename', (f: TAbstractFile, oldPath: string) => {
        if (f instanceof TFile) {
          known.delete(oldPath);
          known.add(f.path);
          listener({ type: 'rename', path: nfc(f.path), oldPath: nfc(oldPath) });
        } else if (f instanceof TFolder) {
          for (const p of under(oldPath)) {
            const moved = f.path + p.slice(oldPath.length);
            known.delete(p);
            known.add(moved);
            listener({ type: 'rename', path: nfc(moved), oldPath: nfc(p) });
          }
        }
      }),
    ];
    return () => {
      for (const r of refs) this.vault.offref(r);
    };
  }
}
