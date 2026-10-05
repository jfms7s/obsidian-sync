// The device's local sync state (spec §4.2), one IndexedDB database per
// synced vault on this device.
import type { KeyBundleFields } from '../crypto/userkeys';
import { inTx, openDb, req } from './idb';

export const DB_VERSION = 1;

const KV = 'kv';
const FILES = 'files';
const BASES = 'bases';
const DIRTY = 'dirty';
const PENDING = 'pending';
const REFUSED = 'refused';
const FAILURES = 'failures';

/** What this device last synced for one file. */
export interface FileRecord {
  fileId: string; // hex
  path: string;
  /** The last version this device applied or committed (a tombstone if deleted); null = not known. */
  versionId: string | null;
  deleted: boolean;
  /** Hex SHA-256 of the synced content; null when deleted or not known. */
  contentHash: string | null;
  size: number;
  /** The local file's mtime when it last matched contentHash (reconcile's fast path). */
  localMtime: number;
  /** A base text for 3-way merges is stored in `bases`. */
  hasBase: boolean;
  /** Not written locally: another file differs from it only in letter case (case-insensitive file systems), or a folder holds its name. */
  shadowed?: boolean;
  /** Not written locally: the path matches this device's ignore rules. */
  ignored?: boolean;
  /** Not written locally: the version is larger than this device's maximum file size. */
  tooLarge?: boolean;
  /** The server seq of versionId (0 = not known); heads never move below it, which reveals a server rollback. */
  seq: number;
}

/** The version this device's cursor points at, checked on the next pull to notice a rolled-back server. */
export interface CursorAnchor {
  seq: number;
  versionId: string;
}

/** A local file the server (or this device's size limit) refused; not pushed again until it changes. */
export interface Refusal {
  path: string;
  /** Content hash, or "stat:<size>:<mtime>" when the file was refused before being read. */
  fingerprint: string;
  message: string;
}

/** A file that failed for a file-specific reason; retried after nextAt. */
export interface Failure {
  key: string; // "push:<path>" or "apply:<fileId>"
  attempts: number;
  nextAt: number;
  message: string;
}

/** A local path that changed and has to be looked at by push. */
export interface DirtyEntry {
  path: string;
  gen: number; // bumped on every change, so push only clears what it saw
  renamedFrom?: string; // set when this path is the new name of a rename
}

/** A commit that may have reached the server; resent unchanged until resolved. */
export interface PendingCommit {
  fileId: string;
  path: string;
  versionId: string;
  baseVersionId: string; // '' for a create
  epoch: number;
  encMeta: Uint8Array;
  chunkIds: Uint8Array[];
  size: number;
  deleted: boolean;
  contentHash: string | null;
  mtime: number;
  /** The committed text, which becomes the merge base once accepted; null for binary files and deletions. */
  text: string | null;
}

export interface Session {
  serverUrl: string;
  username: string;
  userId: string;
  deviceId: string;
  deviceName: string;
  token: string;
}

/** The unlocked private keys, tagged with the account they belong to. */
export interface StoredUserKeys {
  userId: string;
  encPriv: Uint8Array;
  signSeed: Uint8Array;
}

/**
 * First-time key setup in progress: kept from before the upload until the
 * user has confirmed writing the recovery words down.
 */
export interface PendingKeySetup {
  userId: string;
  bundle: KeyBundleFields;
  keys: StoredUserKeys;
  recoveryWords: string;
  uploaded: boolean;
}

/** A vault creation whose request may have reached the server; retried with the same id and keys. */
export interface PendingVault {
  userId: string;
  vaultId: string;
  /** NFC. */
  name: string;
  namingKey: Uint8Array;
  epochKey: Uint8Array;
}

export interface StoredVault {
  /** The account this device chose the vault for; another account logged in here must not sync it. */
  userId: string;
  vaultId: string;
  name: string;
  namingKey: Uint8Array;
  epochKeys: Array<[number, Uint8Array]>;
  currentEpoch: number;
}

/** Creates or migrates the stores; each step runs only for databases older than it. */
export function upgradeSchema(d: IDBDatabase, oldVersion: number): void {
  if (oldVersion < 1) {
    d.createObjectStore(KV);
    const files = d.createObjectStore(FILES, { keyPath: 'fileId' });
    files.createIndex('path', 'path', { unique: false });
    d.createObjectStore(BASES);
    d.createObjectStore(DIRTY, { keyPath: 'path' });
    d.createObjectStore(PENDING, { keyPath: 'fileId' });
    d.createObjectStore(REFUSED, { keyPath: 'path' });
    d.createObjectStore(FAILURES, { keyPath: 'key' });
  }
}

/** The failure key of a pushed path (see sync/failures.ts). */
export const pushFailureKey = (path: string): string => `push:${path}`;

/** KV key of the last dirty generation handed out; never reset, so generations stay unique. */
const DIRTY_GEN = 'dirtyGen';

export class LocalState {
  private constructor(private readonly db: IDBDatabase) {}

  static async open(factory: IDBFactory, name: string): Promise<LocalState> {
    const db = await openDb(factory, name, DB_VERSION, upgradeSchema);
    return new LocalState(db);
  }

  close(): void {
    this.db.close();
  }

  // ---------- key-value ----------

  private async kvGet<T>(key: string): Promise<T | undefined> {
    return inTx(this.db, [KV], 'readonly', (t) => req(t.objectStore(KV).get(key)) as Promise<T | undefined>);
  }

  private async kvPut(key: string, value: unknown): Promise<void> {
    await inTx(this.db, [KV], 'readwrite', (t) => req(t.objectStore(KV).put(value, key)));
  }

  private async kvDelete(key: string): Promise<void> {
    await inTx(this.db, [KV], 'readwrite', (t) => req(t.objectStore(KV).delete(key)));
  }

  getSession(): Promise<Session | undefined> { return this.kvGet('session'); }
  setSession(s: Session): Promise<void> { return this.kvPut('session', s); }
  clearSession(): Promise<void> { return this.kvDelete('session'); }

  getUserKeys(): Promise<StoredUserKeys | undefined> { return this.kvGet('userKeys'); }
  setUserKeys(k: StoredUserKeys): Promise<void> { return this.kvPut('userKeys', k); }
  clearUserKeys(): Promise<void> { return this.kvDelete('userKeys'); }

  /** A key setup whose upload may not have reached the server yet; resent unchanged. */
  getPendingKeySetup(): Promise<PendingKeySetup | undefined> { return this.kvGet('pendingKeySetup'); }
  setPendingKeySetup(p: PendingKeySetup): Promise<void> { return this.kvPut('pendingKeySetup', p); }
  clearPendingKeySetup(): Promise<void> { return this.kvDelete('pendingKeySetup'); }

  getPendingVault(): Promise<PendingVault | undefined> { return this.kvGet('pendingVault'); }
  setPendingVault(p: PendingVault): Promise<void> { return this.kvPut('pendingVault', p); }
  clearPendingVault(): Promise<void> { return this.kvDelete('pendingVault'); }

  getVault(): Promise<StoredVault | undefined> { return this.kvGet('vault'); }
  setVault(v: StoredVault): Promise<void> { return this.kvPut('vault', v); }

  async getCursor(): Promise<number> { return (await this.kvGet<number>('cursor')) ?? 0; }
  setCursor(seq: number): Promise<void> { return this.kvPut('cursor', seq); }
  async getCursorAnchor(): Promise<CursorAnchor | null> { return (await this.kvGet<CursorAnchor | null>('cursorAnchor')) ?? null; }
  setCursorAnchor(a: CursorAnchor | null): Promise<void> { return this.kvPut('cursorAnchor', a); }

  /** Moves the cursor and its anchor together, so a crash cannot leave an anchor for another seq. */
  async setCursorAndAnchor(seq: number, anchor: CursorAnchor | null): Promise<void> {
    await inTx(this.db, [KV], 'readwrite', async (t) => {
      await req(t.objectStore(KV).put(seq, 'cursor'));
      await req(t.objectStore(KV).put(anchor, 'cursorAnchor'));
    });
  }

  async getSetting<T>(key: string, fallback: T): Promise<T> { return (await this.kvGet<T>(`setting:${key}`)) ?? fallback; }
  setSetting(key: string, value: unknown): Promise<void> { return this.kvPut(`setting:${key}`, value); }

  // ---------- files and bases ----------

  getFile(fileId: string): Promise<FileRecord | undefined> {
    return inTx(this.db, [FILES], 'readonly', (t) => req(t.objectStore(FILES).get(fileId)) as Promise<FileRecord | undefined>);
  }

  /** Records whose path is exactly path (normally zero or one). */
  filesByPath(path: string): Promise<FileRecord[]> {
    return inTx(this.db, [FILES], 'readonly', (t) => req(t.objectStore(FILES).index('path').getAll(path)) as Promise<FileRecord[]>);
  }

  allFiles(): Promise<FileRecord[]> {
    return inTx(this.db, [FILES], 'readonly', (t) => req(t.objectStore(FILES).getAll()) as Promise<FileRecord[]>);
  }

  getBase(fileId: string): Promise<string | undefined> {
    return inTx(this.db, [BASES], 'readonly', (t) => req(t.objectStore(BASES).get(fileId)) as Promise<string | undefined>);
  }

  /**
   * Stores what was synced for one file in one transaction: the record, its
   * base text (a string to store, null to drop) and, with clearPending, the
   * removal of the pending commit that produced it: only if that pending
   * commit is for rec.versionId, so a newer one is never lost.
   */
  async recordSynced(rec: FileRecord, base: string | null, clearPending = false): Promise<void> {
    await inTx(this.db, [FILES, BASES, PENDING], 'readwrite', async (t) => {
      await req(t.objectStore(FILES).put({ ...rec, hasBase: base !== null }));
      if (base !== null) await req(t.objectStore(BASES).put(base, rec.fileId));
      else await req(t.objectStore(BASES).delete(rec.fileId));
      if (clearPending) {
        const p = (await req(t.objectStore(PENDING).get(rec.fileId))) as PendingCommit | undefined;
        if (p && p.versionId === rec.versionId) await req(t.objectStore(PENDING).delete(rec.fileId));
      }
    });
  }

  /** Updates only the bookkeeping fields of a record (no base change). */
  async putFile(rec: FileRecord): Promise<void> {
    await inTx(this.db, [FILES], 'readwrite', (t) => req(t.objectStore(FILES).put(rec)));
  }

  // ---------- dirty paths ----------

  /**
   * Marks path as changed locally. A later rename hint replaces an earlier
   * one. The generation counter lives in the database, in the same
   * transaction, so two LocalState instances never hand out the same one.
   * A rename drops the push failure of the old path (it no longer exists).
   */
  async markDirty(path: string, renamedFrom?: string): Promise<number> {
    return inTx(this.db, [DIRTY, KV, FAILURES], 'readwrite', async (t) => {
      const kv = t.objectStore(KV);
      const gen = (((await req(kv.get(DIRTY_GEN))) as number | undefined) ?? (await maxGen(t.objectStore(DIRTY)))) + 1;
      await req(kv.put(gen, DIRTY_GEN));
      const store = t.objectStore(DIRTY);
      const prev = (await req(store.get(path))) as DirtyEntry | undefined;
      const entry: DirtyEntry = { path, gen };
      const hint = renamedFrom ?? prev?.renamedFrom;
      if (hint !== undefined) entry.renamedFrom = hint;
      await req(store.put(entry));
      if (renamedFrom !== undefined && renamedFrom !== path) await req(t.objectStore(FAILURES).delete(pushFailureKey(renamedFrom)));
      return gen;
    });
  }

  dirtyEntries(): Promise<DirtyEntry[]> {
    return inTx(this.db, [DIRTY], 'readonly', (t) => req(t.objectStore(DIRTY).getAll()) as Promise<DirtyEntry[]>);
  }

  /**
   * Removes path's entry if nothing marked it again since gen; reports
   * whether it did. Push is then done with the path, so its push failure
   * (if any) goes too.
   */
  async clearDirty(path: string, gen: number): Promise<boolean> {
    return inTx(this.db, [DIRTY, FAILURES], 'readwrite', async (t) => {
      const store = t.objectStore(DIRTY);
      const cur = (await req(store.get(path))) as DirtyEntry | undefined;
      if (!cur || cur.gen !== gen) return false;
      await req(store.delete(path));
      await req(t.objectStore(FAILURES).delete(pushFailureKey(path)));
      return true;
    });
  }

  // ---------- pending commits ----------

  getPending(fileId: string): Promise<PendingCommit | undefined> {
    return inTx(this.db, [PENDING], 'readonly', (t) => req(t.objectStore(PENDING).get(fileId)) as Promise<PendingCommit | undefined>);
  }

  allPending(): Promise<PendingCommit[]> {
    return inTx(this.db, [PENDING], 'readonly', (t) => req(t.objectStore(PENDING).getAll()) as Promise<PendingCommit[]>);
  }

  async putPending(p: PendingCommit): Promise<void> {
    await inTx(this.db, [PENDING], 'readwrite', (t) => req(t.objectStore(PENDING).put(p)));
  }

  async deletePending(fileId: string): Promise<void> {
    await inTx(this.db, [PENDING], 'readwrite', (t) => req(t.objectStore(PENDING).delete(fileId)));
  }

  // ---------- refusals and failures ----------

  getRefusal(path: string): Promise<Refusal | undefined> {
    return inTx(this.db, [REFUSED], 'readonly', (t) => req(t.objectStore(REFUSED).get(path)) as Promise<Refusal | undefined>);
  }

  async putRefusal(r: Refusal): Promise<void> {
    await inTx(this.db, [REFUSED], 'readwrite', (t) => req(t.objectStore(REFUSED).put(r)));
  }

  async deleteRefusal(path: string): Promise<void> {
    await inTx(this.db, [REFUSED], 'readwrite', (t) => req(t.objectStore(REFUSED).delete(path)));
  }

  getFailure(key: string): Promise<Failure | undefined> {
    return inTx(this.db, [FAILURES], 'readonly', (t) => req(t.objectStore(FAILURES).get(key)) as Promise<Failure | undefined>);
  }

  allFailures(): Promise<Failure[]> {
    return inTx(this.db, [FAILURES], 'readonly', (t) => req(t.objectStore(FAILURES).getAll()) as Promise<Failure[]>);
  }

  async putFailure(f: Failure): Promise<void> {
    await inTx(this.db, [FAILURES], 'readwrite', (t) => req(t.objectStore(FAILURES).put(f)));
  }

  async deleteFailure(key: string): Promise<void> {
    await inTx(this.db, [FAILURES], 'readwrite', (t) => req(t.objectStore(FAILURES).delete(key)));
  }

  // ---------- resets ----------

  /**
   * Forgets every synced version while keeping paths: after the server lost
   * history (restored from a backup), every local file is compared with the
   * server again instead of being trusted as synced.
   */
  async forgetSyncedVersions(): Promise<void> {
    await inTx(this.db, [FILES, BASES, PENDING, KV], 'readwrite', async (t) => {
      const files = (await req(t.objectStore(FILES).getAll())) as FileRecord[];
      for (const f of files) {
        await req(t.objectStore(FILES).put({ ...f, versionId: null, contentHash: null, hasBase: false, localMtime: -1, seq: 0 }));
      }
      await req(t.objectStore(BASES).clear());
      await req(t.objectStore(PENDING).clear());
      await req(t.objectStore(KV).put(0, 'cursor'));
      await req(t.objectStore(KV).put(null, 'cursorAnchor'));
    });
  }

  /**
   * Drops all sync state for the vault (switching vaults or logging out):
   * files, bases, pending commits, dirty paths, refusals, failures, the
   * cursor and the stored vault keys. The session, the user's keys, a
   * pending key setup, a pending vault creation, settings and the dirty
   * generation counter are kept.
   */
  async resetVaultState(): Promise<void> {
    await inTx(this.db, [FILES, BASES, PENDING, DIRTY, REFUSED, FAILURES, KV], 'readwrite', async (t) => {
      for (const s of [FILES, BASES, PENDING, DIRTY, REFUSED, FAILURES]) await req(t.objectStore(s).clear());
      await req(t.objectStore(KV).delete('cursor'));
      await req(t.objectStore(KV).delete('cursorAnchor'));
      await req(t.objectStore(KV).delete('vault'));
    });
  }
}

/** The highest generation among stored dirty entries (databases written before the counter was persisted). */
async function maxGen(store: IDBObjectStore): Promise<number> {
  const all = (await req(store.getAll())) as DirtyEntry[];
  return all.reduce((m, e) => Math.max(m, e.gen), 0);
}
