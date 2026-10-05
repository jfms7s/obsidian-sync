// Applying one remote version to the local vault (spec §5.5).
import type { RemoteVersion } from '../api/types';
import { decryptMeta, type FileMeta } from '../crypto/objects';
import { CryptoError } from '../crypto/primitives';
import { merge3 } from '../merge/merge3';
import type { FileRecord, PendingCommit } from '../state/store';
import { equalBytes, toHex, utf8 } from '../util/bytes';
import { caseFold, conflictCopyName } from '../util/path';
import { expectFor } from '../vault/adapter';
import { evictBlockingFile, saveBeside } from './collisions';
import { decodeText, downloadContent, hashHex } from './content';
import type { SyncContext } from './context';
import { applyKey, clearFailure, isFileError, recordFailure } from './failures';
import { isSyncedHere, readLocal, type LocalFile } from './local';

export { isSyncedHere, readLocal, type LocalFile } from './local';

/** Whether applying versionId to rec has nothing left to do. */
export function alreadyApplied(rec: FileRecord | undefined, versionId: string, ctx: SyncContext): boolean {
  if (!rec || rec.versionId !== versionId) return false;
  if (rec.shadowed) return false; // re-check: the colliding file may be gone
  if (rec.ignored && !ctx.ignore.matches(rec.path)) return false; // the ignore rules changed
  if (rec.tooLarge && rec.size <= ctx.maxFileBytes) return false; // the limit changed
  return true;
}

function record(fileId: string, path: string, versionId: string, v: RemoteVersion, contentHash: string | null, localMtime: number, extra: Partial<FileRecord> = {}): FileRecord {
  return {
    fileId, path, versionId, deleted: v.deleted, contentHash: v.deleted ? null : contentHash, size: v.deleted ? 0 : v.size,
    localMtime, hasBase: false, seq: v.seq, ...extra,
  };
}

async function freeConflictPath(ctx: SyncContext, path: string, device: string): Promise<string> {
  const now = ctx.clock.now();
  for (let n = 1; ; n++) {
    const candidate = conflictCopyName(path, device, now, n);
    if (!(await ctx.adapter.stat(candidate)) && (await ctx.state.filesByPath(candidate)).length === 0) return candidate;
  }
}

/** A version must agree with its own metadata: a deletion has no content, anything else has a hash and the same size. */
function checkConsistent(v: RemoteVersion, meta: FileMeta): void {
  const ok = v.deleted
    ? meta.contentHash.length === 0 && meta.size === 0 && v.size === 0 && v.chunkIds.length === 0
    : meta.contentHash.length === 32 && meta.size === v.size;
  if (!ok) throw new CryptoError('the version does not match its metadata');
}

/**
 * Applies v following the table in spec §5.5. Per-file problems (see
 * failures.ts) are recorded and skipped (the result is then false); only
 * cycle errors are thrown.
 */
export async function applyVersion(ctx: SyncContext, v: RemoteVersion): Promise<boolean> {
  const fileId = toHex(v.fileId);
  try {
    await applyOne(ctx, v, fileId);
    await clearFailure(ctx, applyKey(fileId));
    return true;
  } catch (err) {
    if (!isFileError(ctx, err)) throw err;
    let path = fileId;
    try {
      path = (await decryptMeta(ctx.ring, v.epoch, v.fileId, v.versionId, v.encMeta)).path;
    } catch {
      // keep the id
    }
    await recordFailure(ctx, applyKey(fileId), path, err);
    return false;
  }
}

/**
 * Applies head, a file's newest version, after first applying this
 * device's own pending commit if it is among known (other versions the
 * caller fetched: a change-log page or the file's history). That pending
 * commit landed although its response was lost, and newer versions built
 * on it overtook it; applying only the head would merge it against the
 * record from before the commit and turn this device's own edit into a
 * conflict. When adopting the commit fails, the head is left for the
 * retry of that failure. Returns whether everything was applied.
 */
export async function applyHead(ctx: SyncContext, head: RemoteVersion, known: readonly RemoteVersion[]): Promise<boolean> {
  const pending = await ctx.state.getPending(toHex(head.fileId));
  if (pending && pending.versionId !== toHex(head.versionId)) {
    const own = known.find((v) => toHex(v.versionId) === pending.versionId && equalBytes(v.fileId, head.fileId) && v.seq < head.seq);
    if (own && !(await applyVersion(ctx, own))) return false;
  }
  return applyVersion(ctx, head);
}

async function applyOne(ctx: SyncContext, v: RemoteVersion, fileId: string): Promise<void> {
  const versionId = toHex(v.versionId);
  const stored = await ctx.state.getFile(fileId);
  if (alreadyApplied(stored, versionId, ctx)) return;
  // An older version than the one already recorded (a conflict resolution
  // applied the head before the change log reached it): applying it would
  // roll the file back. A record whose seq is unknown (0) has no such
  // guard; every path that resets a record for re-application (a server
  // rollback, a head the server no longer has) also resets its seq.
  if (stored?.versionId != null && stored.seq > v.seq) return;
  const pending = await ctx.state.getPending(fileId);

  // This device's own pending commit, which landed although its response
  // was lost: record it as synced (its text becomes the base).
  if (pending && pending.versionId === versionId) {
    await adoptLanded(ctx, pending, v);
    return;
  }
  // A version built on this device's pending commit also proves that commit
  // landed: merge against it, not the older record.
  const landed = pending && pending.versionId === toHex(v.baseVersionId) ? pending : undefined;
  const rec: FileRecord | undefined = landed
    ? {
      fileId, path: landed.path, versionId: landed.versionId, deleted: landed.deleted, contentHash: landed.contentHash,
      size: landed.size, localMtime: -1, hasBase: landed.text !== null, seq: 0,
    }
    : stored;
  const baseText = async (): Promise<string> => (landed ? (landed.text ?? '') : ((await ctx.state.getBase(fileId)) ?? ''));

  const meta = await decryptMeta(ctx.ring, v.epoch, v.fileId, v.versionId, v.encMeta);
  checkConsistent(v, meta);
  const path = meta.path;
  const contentHash = v.deleted ? null : toHex(meta.contentHash);

  if (ctx.ignore.matches(path)) {
    await ctx.state.recordSynced(record(fileId, path, versionId, v, contentHash, -1, { ignored: true }), null);
    return;
  }
  if (!v.deleted && v.size > ctx.maxFileBytes) {
    const kept = await keepLocalEditBeside(ctx, path, rec);
    if (kept === false) {
      // The local file changed while it was being moved: leave the record
      // as it is; reconcile retries this version.
      await ctx.state.markDirty(path);
      throw new Error(`${path} changed while it was being saved as a conflict copy`);
    }
    await ctx.state.recordSynced(record(fileId, path, versionId, v, contentHash, -1, { tooLarge: true }), null);
    const also = kept ? `; the local changes were saved as ${kept}` : '';
    ctx.emit({ type: 'notice', code: 'TOO_LARGE', persistent: true, path, message: `${path} (${v.size} bytes) is larger than this device syncs and was not downloaded${also}` });
    return;
  }

  let content: Uint8Array | null = null;
  const remote = async (): Promise<Uint8Array> => (content ??= await downloadContent(ctx.api, ctx.ring, v, meta.contentHash));

  for (let attempt = 0; attempt < 5; attempt++) {
    if (await tryApply(ctx, v, meta, rec, fileId, versionId, contentHash, remote, baseText)) return;
  }
  // The local file changed under us on every attempt: it is being edited.
  // Leave the record as it was; the push of that edit will conflict and
  // bring this version back.
  await ctx.state.markDirty(path);
}

/**
 * Before a too large remote version takes over path (it is then never
 * pushed from here again): a local file that differs from what was last
 * synced would be stranded, so it moves to a conflict copy, which is
 * pushed as a file of its own. Returns the copy's path, null when nothing
 * had to move, or false when the local file changed meanwhile.
 */
async function keepLocalEditBeside(ctx: SyncContext, path: string, rec: FileRecord | undefined): Promise<string | null | false> {
  const local = await readLocal(ctx, path);
  if (!local) return null;
  if (isSyncedHere(rec) && !rec.deleted && (await hashHex(local.data)) === rec.contentHash) return null;
  const copy = await freeConflictPath(ctx, path, ctx.deviceName);
  if (!(await ctx.adapter.rename(path, copy, expectFor(local.stat)))) return false;
  await ctx.state.markDirty(copy);
  return copy;
}

async function adoptLanded(ctx: SyncContext, p: PendingCommit, v: RemoteVersion): Promise<void> {
  const local = await readLocal(ctx, p.path);
  const localHash = local ? await hashHex(local.data) : null;
  const matches = p.deleted ? local === null : localHash === p.contentHash;
  await ctx.state.recordSynced(
    { fileId: p.fileId, path: p.path, versionId: p.versionId, deleted: p.deleted, contentHash: p.contentHash, size: p.size, localMtime: matches && local ? local.stat.mtime : -1, hasBase: false, seq: v.seq },
    p.text,
    true,
  );
  if (!matches) await ctx.state.markDirty(p.path);
}

/** One attempt; false when a write precondition failed because the local file changed meanwhile. */
async function tryApply(
  ctx: SyncContext, v: RemoteVersion, meta: FileMeta, rec: FileRecord | undefined, fileId: string, versionId: string,
  contentHash: string | null, remote: () => Promise<Uint8Array>, baseText: () => Promise<string>,
): Promise<boolean> {
  const path = meta.path;
  const { adapter, state } = ctx;

  // A file and a folder cannot share a path; the folder wins (collisions.ts).
  if (!v.deleted) {
    if (await adapter.hasFolder(path)) {
      if (!rec?.shadowed) {
        const copy = await saveBeside(ctx, meta, contentHash!, await remote());
        if (copy === null) return false;
        ctx.emit({ type: 'notice', code: 'PATH_COLLISION', persistent: false, path, conflictPath: copy, message: `${path} is a folder on this device; the file was saved as ${copy}` });
      }
      await state.recordSynced(record(fileId, path, versionId, v, contentHash, -1, { shadowed: true }), null);
      return true;
    }
    if (!(await evictBlockingFile(ctx, path))) return false;
  }

  // Case-insensitive file systems: a different file already holds this
  // name in another case (spec §5.1).
  if (adapter.caseInsensitive && !v.deleted) {
    const st = await adapter.stat(path);
    if (st && st.path !== path) {
      // A case-only rename on another device (todo.md → TODO.md) whose
      // create arrives before its delete: rename the unchanged local file.
      if (meta.renamedFrom && caseFold(meta.renamedFrom) === caseFold(st.path)) {
        const old = (await state.filesByPath(st.path)).find(isSyncedHere);
        const local = await adapter.read(st.path);
        if (old && !old.deleted && local && (await hashHex(local)) === old.contentHash) {
          if (!(await adapter.rename(st.path, path, expectFor(st)))) return false;
          const data = await remote();
          const renamed = await adapter.stat(path);
          if (!renamed || !(await adapter.write(path, data, expectFor(renamed)))) return false;
          const after = await adapter.stat(path);
          await state.recordSynced(record(fileId, path, versionId, v, contentHash, after?.mtime ?? -1), decodeText(path, data));
          ctx.emit({ type: 'remote-change', path, action: 'write' });
          return true;
        }
      }
      // Otherwise the incoming file is written once as a conflict copy and
      // not tracked at its own path.
      if (!rec?.shadowed) {
        const copy = await saveBeside(ctx, meta, contentHash!, await remote());
        if (copy === null) return false;
        ctx.emit({ type: 'notice', code: 'CASE_COLLISION', persistent: false, path, conflictPath: copy, message: `${path} differs only in letter case from ${st.path}; this device saved it as ${copy}` });
      }
      await state.recordSynced(record(fileId, path, versionId, v, contentHash, -1, { shadowed: true }), null);
      return true;
    }
  }

  const local = await readLocal(ctx, path);
  const synced = isSyncedHere(rec);
  const liveBase = synced && !rec.deleted;
  const localHash = local ? await hashHex(local.data) : null;
  const localChanged = local ? !(liveBase && localHash === rec.contentHash) : liveBase;

  if (v.deleted) {
    if (local && !localChanged) {
      if (!(await adapter.remove(path, expectFor(local.stat)))) return false;
      ctx.emit({ type: 'remote-change', path, action: 'delete' });
    }
    await state.recordSynced(record(fileId, path, versionId, v, null, -1), null);
    // A local edit against a remote delete: the edit wins and is pushed
    // again on top of the tombstone.
    if (local && localChanged) await state.markDirty(path);
    return true;
  }

  const data = await remote();
  const text = decodeText(path, data);

  if (!local || !localChanged) {
    // New here, unchanged here, or deleted here (a remote edit wins over a local delete).
    if (!(await adapter.write(path, data, expectFor(local?.stat ?? null)))) return false;
    const after = await adapter.stat(path);
    await state.recordSynced(record(fileId, path, versionId, v, contentHash, after?.mtime ?? -1), text);
    ctx.emit({ type: 'remote-change', path, action: 'write' });
    return true;
  }

  if (localHash === contentHash) {
    await state.recordSynced(record(fileId, path, versionId, v, contentHash, local.stat.mtime), text);
    return true;
  }

  const localText = decodeText(path, local.data);
  if (text !== null && localText !== null) {
    const base = liveBase && rec.hasBase ? await baseText() : '';
    const m = merge3(base, localText, text);
    if (m.clean) {
      if (m.text !== localText && !(await adapter.write(path, utf8(m.text), expectFor(local.stat)))) return false;
      await state.recordSynced(record(fileId, path, versionId, v, contentHash, -1), text);
      if (m.text !== text) await state.markDirty(path);
      ctx.emit({ type: 'merged', path });
      return true;
    }
  }

  // Overlapping edits, or a binary file: keep local, save remote beside it.
  const copy = await freeConflictPath(ctx, path, meta.deviceName || 'unknown device');
  if (!(await adapter.write(copy, data, { absent: true }))) return false;
  await state.markDirty(copy);
  await state.recordSynced(record(fileId, path, versionId, v, contentHash, -1), text);
  await state.markDirty(path);
  ctx.emit({ type: 'conflict', path, conflictPath: copy });
  return true;
}
