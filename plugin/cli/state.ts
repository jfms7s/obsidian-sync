// obsync-cli's sync state (spec D3): the plugin's LocalState over an
// in-memory IndexedDB (fake-indexeddb), saved as one JSON snapshot after
// each sync cycle and on exit, and loaded again on start.
//
// A crash loses what changed since the last snapshot, which is safe to
// replay: pulls restart from the saved cursor and re-apply versions whose
// content already matches (no conflict copy when the hashes are equal), and
// commits are resent with the pending commits' version ids, which the
// server answers with OK when the commit had landed.
//
// The snapshot carries the database's schema (stores, key paths, indexes)
// and version, so a newer obsync-cli loads it as written and then lets
// LocalState migrate it like any IndexedDB database.
import { IDBFactory } from 'fake-indexeddb';
import { chmod, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { LocalState } from '../src/index';

export const SNAPSHOT_FILE = 'state.json';
const DB_NAME = 'obsync-cli';
const FORMAT = 1;

interface IndexSnapshot {
  name: string;
  keyPath: string | string[];
  unique: boolean;
  multiEntry: boolean;
}

interface StoreSnapshot {
  name: string;
  keyPath: string | string[] | null;
  autoIncrement: boolean;
  indexes: IndexSnapshot[];
  /** [key, value] in key order; the key is only used for stores without a key path. */
  records: Array<[IDBValidKey, unknown]>;
}

interface Snapshot {
  format: number;
  /** The IndexedDB version of the database when it was saved. */
  version: number;
  stores: StoreSnapshot[];
}

/** The snapshot cannot be read: a damaged file, or one written by a newer obsync-cli. */
export class StateFileError extends Error {
  constructor(readonly file: string, why: string) {
    super(`${file}: ${why}`);
    this.name = 'StateFileError';
  }
}

// ----- JSON with byte arrays -----

const BYTES = '$bytes';

function replacer(this: unknown, key: string, value: unknown): unknown {
  // value is what toJSON made of the original (a Date is a string by now): look at the original.
  const raw = (this as Record<string, unknown>)[key];
  if (raw instanceof Date) throw new TypeError('the state snapshot cannot hold a Date');
  if (value instanceof Uint8Array) return { [BYTES]: Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('base64') };
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value) || value instanceof Map || value instanceof Set || value instanceof Date) {
    // Not stored by LocalState today; a silent change of type on reload would be worse than failing here.
    throw new TypeError(`the state snapshot cannot hold a ${Object.prototype.toString.call(value)}`);
  }
  return value;
}

function reviver(_key: string, value: unknown): unknown {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const keys = Object.keys(value);
    if (keys.length === 1 && keys[0] === BYTES) return new Uint8Array(Buffer.from((value as Record<string, string>)[BYTES]!, 'base64'));
  }
  return value;
}

// ----- IndexedDB, raw -----

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error('IndexedDB request failed'));
  });
}

function openRaw(factory: IDBFactory, version?: number, upgrade?: (db: IDBDatabase) => void): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = version === undefined ? factory.open(DB_NAME) : factory.open(DB_NAME, version);
    if (upgrade) r.onupgradeneeded = () => upgrade(r.result);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error('cannot open the state database'));
    r.onblocked = () => reject(new Error('the state database is open with an older version'));
  });
}

/** Every store with its schema and records, read in one transaction (so from one consistent state). */
async function readSnapshot(factory: IDBFactory): Promise<Snapshot> {
  const db = await openRaw(factory);
  try {
    const names = [...db.objectStoreNames];
    const t = db.transaction(names, 'readonly');
    const stores = await Promise.all(names.map(async (name): Promise<StoreSnapshot> => {
      const s = t.objectStore(name);
      const [keys, values] = await Promise.all([req(s.getAllKeys()), req(s.getAll())]);
      return {
        name,
        keyPath: s.keyPath,
        autoIncrement: s.autoIncrement,
        indexes: [...s.indexNames].map((n) => {
          const i = s.index(n);
          return { name: n, keyPath: i.keyPath, unique: i.unique, multiEntry: i.multiEntry };
        }),
        records: keys.map((k, n) => [k, values[n]]),
      };
    }));
    return { format: FORMAT, version: db.version, stores };
  } finally {
    db.close();
  }
}

/** Recreates the database a snapshot describes, at its version, in the factory. */
async function restore(factory: IDBFactory, snap: Snapshot): Promise<void> {
  let failure: unknown = null;
  const db = await openRaw(factory, snap.version, (d) => {
    for (const s of snap.stores) {
      const store = d.createObjectStore(s.name, { keyPath: s.keyPath, autoIncrement: s.autoIncrement });
      for (const i of s.indexes) store.createIndex(i.name, i.keyPath, { unique: i.unique, multiEntry: i.multiEntry });
      for (const [key, value] of s.records) {
        const r = s.keyPath === null ? store.put(value, key) : store.put(value);
        r.onerror = () => {
          failure ??= r.error;
        };
      }
    }
  });
  db.close();
  if (failure) throw failure;
}

function parse(file: string, text: string): Snapshot {
  let snap: Snapshot;
  try {
    snap = JSON.parse(text, reviver) as Snapshot;
  } catch (err) {
    throw new StateFileError(file, `not valid JSON (${(err as Error).message}); move it away to start over (this device then has to log in again)`);
  }
  if (snap?.format !== FORMAT || !Number.isInteger(snap.version) || !Array.isArray(snap.stores)) {
    throw new StateFileError(file, `not an obsync-cli state file of format ${FORMAT} (written by a newer obsync-cli?)`);
  }
  return snap;
}

// ----- files -----

/** Writes a file whole or not at all: a temporary file, fsync, rename over the target, fsync of the folder. */
export async function writeFileAtomic(path: string, data: string): Promise<void> {
  const tmp = `${path}.tmp`;
  const fh = await open(tmp, 'w', 0o600);
  try {
    try {
      await fh.writeFile(data);
      await fh.chmod(0o600);
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(tmp, path);
  } catch (err) {
    await unlink(tmp).catch(() => undefined);
    throw err;
  }
  const dir = await open(join(path, '..'), 'r');
  try {
    await dir.sync();
  } finally {
    await dir.close();
  }
}

/**
 * The CLI's LocalState and its snapshot file. The state directory holds the
 * session token and the unlocked keys, so it is kept at mode 0700 and the
 * snapshot at 0600.
 */
export class PersistentState {
  private saving: Promise<unknown> = Promise.resolve();
  /** LocalState was changed since the last save began (see track). */
  private changed = false;
  /** The LocalState to use: every change through it is noticed, so saveIfChanged knows. */
  readonly state: LocalState;

  private constructor(
    readonly dir: string,
    state: LocalState,
    private readonly factory: IDBFactory,
  ) {
    this.state = this.track(state);
  }

  /**
   * LocalState with every call of a method that may write marking the
   * state changed. Only methods known to read (get…, all…, filesBy…,
   * filesAt…, dirtyEntries, maxFileSeq) do not: a new method counts as a
   * write until it is added here, which costs a save, never a lost change.
   */
  private track(state: LocalState): LocalState {
    const reads = /^(get|all|filesBy|filesAt|dirtyEntries$|maxFileSeq$|close$)/;
    return new Proxy(state, {
      get: (target, prop, receiver) => {
        const value: unknown = Reflect.get(target, prop, receiver);
        if (typeof value !== 'function' || typeof prop !== 'string') return value;
        const fn = value as (...args: unknown[]) => unknown;
        if (reads.test(prop)) return fn.bind(target);
        return (...args: unknown[]) => {
          const mark = () => {
            this.changed = true;
          };
          mark();
          const result = fn.apply(target, args);
          // Again once it is done: a save that began meanwhile may have read the database before the write landed.
          if (result instanceof Promise) result.then(mark, mark);
          return result;
        };
      },
    });
  }

  get file(): string {
    return join(this.dir, SNAPSHOT_FILE);
  }

  /** Opens the state in dir (created if missing), loading its snapshot if there is one. */
  static async open(dir: string): Promise<PersistentState> {
    // Only a folder made here is set to 0700 (mkdir's mode is cut by the umask); an existing one is the user's.
    if ((await mkdir(dir, { recursive: true, mode: 0o700 })) !== undefined) await chmod(dir, 0o700);
    const file = join(dir, SNAPSHOT_FILE);
    const factory = new IDBFactory();
    let text: string | null = null;
    try {
      text = await readFile(file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    if (text !== null) {
      const snap = parse(file, text);
      try {
        await restore(factory, snap);
      } catch (err) {
        throw new StateFileError(file, `cannot be loaded: ${(err as Error).message}`);
      }
    }
    let state: LocalState;
    try {
      state = await LocalState.open(factory, DB_NAME);
    } catch (err) {
      throw new StateFileError(file, `cannot be opened (written by a newer obsync-cli?): ${(err as Error).message}`);
    }
    return new PersistentState(dir, state, factory);
  }

  /**
   * Writes the snapshot; saves never overlap, and one asked for while
   * another runs starts after it (so it holds everything up to the ask).
   * Resolves with how long it took, in ms.
   */
  save(): Promise<number> {
    const run = this.saving.then(async () => {
      this.changed = false;
      const started = performance.now();
      const text = JSON.stringify(await readSnapshot(this.factory), replacer);
      await writeFileAtomic(this.file, text);
      return performance.now() - started;
    });
    this.saving = run.catch(() => {
      this.changed = true; // not on disk: the next saveIfChanged tries again
    });
    return run;
  }

  /** Saves if anything changed since the last save began; null if there was nothing to save. */
  async saveIfChanged(): Promise<number | null> {
    await this.saving;
    return this.changed ? this.save() : null;
  }

  /** Waits for any save in flight, then closes the database (nothing is saved). */
  async close(): Promise<void> {
    await this.saving;
    this.state.close();
  }
}
