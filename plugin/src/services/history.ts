// History and trash for the history view (plan 3).
import type { ApiClient } from '../api/client';
import type { RemoteVersion } from '../api/types';
import { decryptMeta, fileIdFor, type FileMeta } from '../crypto/objects';
import type { VaultKeyring } from '../crypto/vaultkeys';
import type { LocalState } from '../state/store';
import { toHex } from '../util/bytes';
import { normalizePath } from '../util/path';
import { expectFor, type VaultAdapter } from '../vault/adapter';
import { downloadContent, hashHex } from '../sync/content';

/** The file has local changes that have not been synced yet; restoring now would overwrite them. */
export class UnsyncedChangesError extends Error {
  constructor(readonly path: string) {
    super(`${path} has changes that are not synced yet; sync, then restore`);
    this.name = 'UnsyncedChangesError';
  }
}

/**
 * On a case-insensitive file system, another file whose name differs only
 * in letter case already holds the path; restoring would overwrite it.
 * Rename or remove that file first.
 */
export class PathOccupiedError extends Error {
  constructor(readonly path: string, readonly occupiedBy: string) {
    super(`${path} cannot be restored: ${occupiedBy} already holds that name`);
    this.name = 'PathOccupiedError';
  }
}

export interface HistoryEntry {
  version: RemoteVersion;
  versionId: string; // hex
  /** null if this version's metadata failed to decrypt. */
  meta: FileMeta | null;
}

async function describe(ring: VaultKeyring, versions: RemoteVersion[]): Promise<HistoryEntry[]> {
  const out: HistoryEntry[] = [];
  for (const v of versions) {
    let meta: FileMeta | null = null;
    try {
      meta = await decryptMeta(ring, v.epoch, v.fileId, v.versionId, v.encMeta);
    } catch {
      meta = null;
    }
    out.push({ version: v, versionId: toHex(v.versionId), meta });
  }
  return out;
}

/** Every retained version of the file at path, newest first (tombstones included). */
export async function fileHistory(api: ApiClient, ring: VaultKeyring, path: string): Promise<HistoryEntry[]> {
  return describe(ring, await api.history(ring.vaultId, await fileIdFor(ring.namingKey, normalizePath(path))));
}

/** Deleted files that can still be restored, newest deletion first. */
export async function listTrash(api: ApiClient, ring: VaultKeyring): Promise<HistoryEntry[]> {
  return describe(ring, await api.trash(ring.vaultId));
}

/** The plaintext of one version (for a diff view). Tombstones have none. */
export async function readVersion(api: ApiClient, ring: VaultKeyring, entry: HistoryEntry): Promise<Uint8Array> {
  if (entry.version.deleted || !entry.meta) throw new Error('this version has no content');
  return downloadContent(api, ring, entry.version, entry.meta.contentHash);
}

/**
 * Restores an earlier version, or a deleted file from the trash, by writing
 * its content to its path like a user edit; the engine then pushes it as a
 * new version on top of the current head. For a trash entry (a tombstone),
 * the newest version with content is restored. A local file with unsynced
 * changes is never overwritten: that throws UnsyncedChangesError. So does a
 * local delete that is not synced yet, and a commit of the file that is
 * still waiting for the server's answer. On a case-insensitive file system,
 * a different file whose name differs only in case throws PathOccupiedError.
 */
export async function restore(api: ApiClient, ring: VaultKeyring, adapter: VaultAdapter, state: LocalState, entry: HistoryEntry): Promise<string> {
  let target = entry;
  if (entry.version.deleted) {
    const history = await describe(ring, await api.history(ring.vaultId, entry.version.fileId));
    const live = history.find((h) => !h.version.deleted && h.meta);
    if (!live) throw new Error('no restorable version is left');
    target = live;
  }
  if (!target.meta) throw new Error('this version cannot be decrypted');
  const path = target.meta.path;
  const fileId = toHex(target.version.fileId);
  const data = await readVersion(api, ring, target);
  if (await state.getPending(fileId)) throw new UnsyncedChangesError(path);
  const stat = await adapter.stat(path);
  if (stat && stat.path !== path) throw new PathOccupiedError(path, stat.path);
  const local = stat ? await adapter.read(path) : null;
  const rec = await state.getFile(fileId);
  if (local) {
    if (!rec || rec.deleted || rec.contentHash !== (await hashHex(local))) throw new UnsyncedChangesError(path);
  } else if (rec && !rec.deleted) {
    // Synced as live but gone here: a local delete (or rename) not pushed yet.
    throw new UnsyncedChangesError(path);
  }
  if (!(await adapter.write(path, data, expectFor(stat)))) throw new UnsyncedChangesError(path);
  return path;
}
