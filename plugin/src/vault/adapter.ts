// The engine's only view of the local vault. Plan 3 implements it over
// Obsidian's Vault/DataAdapter; tests use MemoryAdapter.

export interface FileStat {
  /** The path as stored (on a case-insensitive file system it may differ in case from the one asked for). */
  path: string;
  mtime: number;
  size: number;
}

/** A precondition for write/remove: the file must be absent, or still have this mtime and size. */
export type Expect = { absent: true } | { mtime: number; size: number };

/**
 * One event per file (a folder rename is reported as a rename of each file
 * in it). Paths are vault-relative with '/' separators.
 */
export type AdapterEvent =
  | { type: 'create' | 'modify' | 'delete'; path: string }
  | { type: 'rename'; path: string; oldPath: string };

/**
 * Paths passed to an adapter are already normalized (NFC, '/' separators):
 * the engine normalizes them; an adapter need not.
 *
 * mtime may be coarse (whole seconds on some file systems and in Obsidian's
 * mobile adapter), so two writes can share an mtime; the engine never
 * relies on mtime alone to tell versions apart (plan 3's adapter must keep
 * that in mind for expect preconditions). A rename keeps the file's mtime.
 */
export interface VaultAdapter {
  /** Two paths that differ only in letter case name the same file. */
  readonly caseInsensitive: boolean;
  /** Every file in the vault (not folders), including ignored ones. */
  list(): Promise<string[]>;
  /** null means the file does not exist; any other problem (permissions, I/O) must throw. */
  stat(path: string): Promise<FileStat | null>;
  /** The file's bytes, or null if it does not exist. An I/O error must throw, never return null. */
  read(path: string): Promise<Uint8Array | null>;
  /**
   * Writes the file, creating parent folders. If expect is given and does
   * not hold, nothing is written and false is returned.
   */
  write(path: string, data: Uint8Array, expect?: Expect): Promise<boolean>;
  /** Deletes the file (to the system trash where the platform has one); false if expect does not hold. */
  remove(path: string, expect?: Expect): Promise<boolean>;
  /**
   * Renames a file, also when only the letter case changes; false if expect
   * (about oldPath) does not hold or newPath is taken by another file.
   */
  rename(oldPath: string, newPath: string, expect?: Expect): Promise<boolean>;
  /** Subscribes to changes, including those the engine itself makes. */
  watch(listener: (ev: AdapterEvent) => void): () => void;
}

export function expectFor(stat: FileStat | null): Expect {
  return stat ? { mtime: stat.mtime, size: stat.size } : { absent: true };
}
