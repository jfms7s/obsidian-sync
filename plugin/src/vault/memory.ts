// An in-memory VaultAdapter for tests and the convergence suite. It reports
// events for every change, as Obsidian does, and can behave like a
// case-insensitive file system.
import { caseFold } from '../util/path';
import type { Clock } from '../util/clock';
import { systemClock } from '../util/clock';
import type { AdapterEvent, Expect, FileStat, VaultAdapter } from './adapter';

interface Entry {
  path: string;
  data: Uint8Array;
  mtime: number;
}

/**
 * An in-memory adapter for tests and tooling; it holds nothing on disk and
 * is not meant to back a real vault. Exported so the Obsidian integration's
 * tests (plan 3) can drive the engine without a file system.
 */
export class MemoryAdapter implements VaultAdapter {
  private files = new Map<string, Entry>();
  private listeners = new Set<(ev: AdapterEvent) => void>();
  private lastMtime = 0;
  private broken = new Set<string>();
  private brokenStat = new Set<string>();

  constructor(readonly caseInsensitive = false, private readonly clock: Clock = systemClock) {}

  private key(path: string): string {
    return this.caseInsensitive ? caseFold(path) : path;
  }

  private emit(ev: AdapterEvent): void {
    for (const l of [...this.listeners]) l(ev);
  }

  private nextMtime(): number {
    this.lastMtime = Math.max(this.clock.now(), this.lastMtime + 1);
    return this.lastMtime;
  }

  private holds(e: Entry | undefined, expect?: Expect): boolean {
    if (!expect) return true;
    if ('absent' in expect) return e === undefined;
    return e !== undefined && e.mtime === expect.mtime && e.data.length === expect.size;
  }

  private folderHoldsFiles(path: string): boolean {
    const prefix = this.key(path) + '/';
    for (const k of this.files.keys()) if (k.startsWith(prefix)) return true;
    return false;
  }

  /** What a real file system answers: no file over a folder with files, none below a file. */
  private checkPlace(path: string): void {
    if (this.folderHoldsFiles(path)) throw new Error(`EISDIR: ${path} is a folder`);
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) {
      if (this.files.has(this.key(parts.slice(0, i).join('/')))) throw new Error(`ENOTDIR: a file is in the way of ${path}`);
    }
  }

  async hasFolder(path: string): Promise<boolean> {
    return this.folderHoldsFiles(path);
  }

  async list(): Promise<string[]> {
    return [...this.files.values()].map((e) => e.path).sort();
  }

  async stat(path: string): Promise<FileStat | null> {
    if (this.brokenStat.has(this.key(path))) throw new Error(`EIO: cannot stat ${path}`);
    const e = this.files.get(this.key(path));
    return e ? { path: e.path, mtime: e.mtime, size: e.data.length } : null;
  }

  async read(path: string): Promise<Uint8Array | null> {
    if (this.broken.has(this.key(path))) throw new Error(`EIO: cannot read ${path}`);
    const e = this.files.get(this.key(path));
    return e ? e.data.slice() : null;
  }

  async write(path: string, data: Uint8Array, expect?: Expect): Promise<boolean> {
    const k = this.key(path);
    const prev = this.files.get(k);
    if (!this.holds(prev, expect)) return false;
    if (!prev) this.checkPlace(path);
    // Like macOS and Windows: writing over a file keeps its existing name.
    this.files.set(k, { path: prev?.path ?? path, data: data.slice(), mtime: this.nextMtime() });
    this.emit({ type: prev ? 'modify' : 'create', path: prev?.path ?? path });
    return true;
  }

  async remove(path: string, expect?: Expect): Promise<boolean> {
    const k = this.key(path);
    const prev = this.files.get(k);
    if (!this.holds(prev, expect)) return false;
    if (!prev) return true;
    this.files.delete(k);
    this.emit({ type: 'delete', path: prev.path });
    return true;
  }

  async rename(oldPath: string, newPath: string, expect?: Expect): Promise<boolean> {
    const e = this.files.get(this.key(oldPath));
    if (!e || !this.holds(e, expect)) return false;
    if (this.key(oldPath) !== this.key(newPath)) {
      if (this.files.has(this.key(newPath))) return false;
      this.checkPlace(newPath);
    }
    this.files.delete(this.key(oldPath));
    // A rename keeps the mtime, as on real file systems.
    this.files.set(this.key(newPath), { path: newPath, data: e.data, mtime: e.mtime });
    this.emit({ type: 'rename', path: newPath, oldPath: e.path });
    return true;
  }

  /**
   * Makes reads of path throw, like a disk or permission error; with
   * { stat: true } stat throws as well. fail = false clears both.
   */
  failReads(path: string, fail = true, opts: { stat?: boolean } = {}): void {
    const k = this.key(path);
    if (fail) {
      this.broken.add(k);
      if (opts.stat) this.brokenStat.add(k);
    } else {
      this.broken.delete(k);
      this.brokenStat.delete(k);
    }
  }

  watch(listener: (ev: AdapterEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** path → bytes, for comparing vaults. */
  snapshot(): Map<string, Uint8Array> {
    return new Map([...this.files.values()].map((e) => [e.path, e.data.slice()]));
  }

  /** Changes a file without telling anyone, like an edit made while Obsidian was closed. */
  writeSilently(path: string, data: Uint8Array): void {
    const k = this.key(path);
    const prev = this.files.get(k);
    this.files.set(k, { path: prev?.path ?? path, data: data.slice(), mtime: this.nextMtime() });
  }

  removeSilently(path: string): void {
    this.files.delete(this.key(path));
  }
}
