// What the history view needs, over the history services: versions of a file,
// the trash, a comparison with the file as it is now, and restore.
import type { ApiClient } from '../api/client';
import { isAuthFailure, isTemporary, isVaultNotFound, NetworkError } from '../api/errors';
import type { VaultKeyring } from '../crypto/vaultkeys';
import { MissingEpochKeyError } from '../crypto/vaultkeys';
import { fileHistory, listTrash, readVersion, restore, type HistoryEntry } from '../services/history';
import type { LocalState } from '../state/store';
import { decodeText } from '../sync/content';
import type { VaultAdapter } from '../vault/adapter';
import { diffLines, type DiffLine } from './diff';
import { describeError } from './errors';

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
  /** The name of the device that deleted it ('' when the version does not say). */
  device: string;
}

/** Trash items one device deleted in one go: the unit a bulk restore undoes. */
export interface TrashGroup {
  device: string;
  /** Newest deletion first. */
  items: TrashItem[];
  newestMs: number;
  oldestMs: number;
}

/**
 * Deletions by one device that follow each other within this gap belong to
 * one group. A large deletion is pushed in rounds of a few hundred files,
 * seconds apart; separate deletions by hand are usually further apart.
 */
export const TRASH_GROUP_GAP_MS = 5 * 60_000;

/**
 * Groups trash items by the device that deleted them and by time: within a
 * device, an item more than gapMs older than the one before it starts a
 * new group. Groups come newest first, and so do the items in each.
 */
export function groupTrash(items: readonly TrashItem[], gapMs = TRASH_GROUP_GAP_MS): TrashGroup[] {
  const sorted = [...items].sort((a, b) => b.deletedAtMs - a.deletedAtMs);
  const open = new Map<string, TrashGroup>();
  const groups: TrashGroup[] = [];
  for (const item of sorted) {
    const g = open.get(item.device);
    if (g && g.oldestMs - item.deletedAtMs <= gapMs) {
      g.items.push(item);
      g.oldestMs = item.deletedAtMs;
      continue;
    }
    const next: TrashGroup = { device: item.device, items: [item], newestMs: item.deletedAtMs, oldestMs: item.deletedAtMs };
    open.set(item.device, next);
    groups.push(next);
  }
  return groups;
}

export interface RestoreManyResult {
  /** The paths written, in the order they were restored. */
  restored: string[];
  /** Entries that could not be restored and why (it exists again, its name is taken, unsynced local changes, …); the rest went on. */
  skipped: Array<{ path: string; reason: string }>;
  /** The server could not be reached or refused this device: the entries not tried yet were left (null when every entry was tried). */
  stopped: string | null;
}

/** Errors that would fail every remaining restore too: a bulk restore stops on them instead of listing each file. */
function stopsTheRest(err: unknown): boolean {
  return err instanceof NetworkError || isAuthFailure(err) || isVaultNotFound(err) || isTemporary(err) || err instanceof MissingEpochKeyError;
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
      if (entry.meta) out.push({ path: entry.meta.path, entry, deletedAtMs: entry.version.createdAtMs, device: entry.meta.deviceName });
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

  /**
   * Restores trash items one after another, as restore() does for one. An
   * item that cannot be restored is skipped and reported, and the rest go
   * on; an error that would fail the rest too (no connection, the server
   * refusing this device) stops there and is reported in stopped. The
   * caller syncs once at the end.
   */
  async restoreMany(items: readonly TrashItem[]): Promise<RestoreManyResult> {
    const result: RestoreManyResult = { restored: [], skipped: [], stopped: null };
    for (const item of items) {
      try {
        result.restored.push(await this.restore(item.entry));
      } catch (err) {
        if (stopsTheRest(err)) {
          result.stopped = describeError(err).message;
          return result;
        }
        result.skipped.push({ path: item.path, reason: describeError(err).message });
      }
    }
    return result;
  }
}
