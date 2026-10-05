// What the history view needs, over the history services: versions of a file,
// the trash, a comparison with the file as it is now, and restore.
import type { ApiClient } from '../api/client';
import type { VaultKeyring } from '../crypto/vaultkeys';
import { fileHistory, listTrash, readVersion, restore, type HistoryEntry } from '../services/history';
import type { LocalState } from '../state/store';
import { decodeText } from '../sync/content';
import type { VaultAdapter } from '../vault/adapter';
import { diffLines, type DiffLine } from './diff';

export interface HistoryDeps {
  api: ApiClient;
  ring: VaultKeyring;
  adapter: VaultAdapter;
  state: LocalState;
}

export interface TrashItem {
  path: string;
  entry: HistoryEntry;
  /** When it was deleted (the tombstone's time, milliseconds). */
  deletedAtMs: number;
}

/** A version against the file now: lines, null when too long to diff, or binary content. */
export type Comparison = { kind: 'text'; lines: DiffLine[] | null } | { kind: 'binary' };

export class HistoryController {
  constructor(private readonly deps: HistoryDeps) {}

  /** The retained versions of the file at path, newest first. */
  versions(path: string): Promise<HistoryEntry[]> {
    return fileHistory(this.deps.api, this.deps.ring, path);
  }

  /** Deleted files that can be restored, newest deletion first (entries whose metadata cannot be read are left out). */
  async trash(): Promise<TrashItem[]> {
    const out: TrashItem[] = [];
    for (const entry of await listTrash(this.deps.api, this.deps.ring)) {
      if (entry.meta) out.push({ path: entry.meta.path, entry, deletedAtMs: entry.version.createdAtMs });
    }
    return out;
  }

  read(entry: HistoryEntry): Promise<Uint8Array> {
    return readVersion(this.deps.api, this.deps.ring, entry);
  }

  /** What changed between this version and the file as it is on this device now. */
  async compare(entry: HistoryEntry): Promise<Comparison> {
    const path = entry.meta?.path;
    if (!path) throw new Error('this version cannot be decrypted');
    const before = decodeText(path, await this.read(entry));
    if (before === null) return { kind: 'binary' };
    const now = await this.deps.adapter.read(path);
    const after = now === null ? '' : decodeText(path, now);
    if (after === null) return { kind: 'binary' };
    return { kind: 'text', lines: diffLines(before, after) };
  }

  /** Writes the version (or a trashed file's last content) to its path; the engine syncs it as a new version. Returns the path. */
  restore(entry: HistoryEntry): Promise<string> {
    return restore(this.deps.api, this.deps.ring, this.deps.adapter, this.deps.state, entry);
  }
}
