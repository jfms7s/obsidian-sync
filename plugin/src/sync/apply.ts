// Applying one remote version to the local vault (spec §5.5).
import type { RemoteVersion } from '../api/types';
import { decryptMeta, type FileMeta } from '../crypto/objects';
import { CryptoError } from '../crypto/primitives';
import { merge3 } from '../merge/merge3';
import type { FileRecord, PendingCommit } from '../state/store';
import { toHex, utf8 } from '../util/bytes';
import { caseFold, conflictCopyName } from '../util/path';
import { expectFor, type FileStat } from '../vault/adapter';
import { decodeText, downloadContent, hashHex } from './content';
import type { SyncContext } from './context';
import { applyKey, clearFailure, isCycleError, recordFailure } from './failures';

export interface LocalFile {
  data: Uint8Array;
  stat: FileStat;
}

/**
 * The local file at exactly path, or null. On a case-insensitive file
 * system a file stored under another case is not "at" path: it is a
 * different file that happens to collide.
 */
export async function readLocal(ctx: SyncContext, path: string): Promise<LocalFile | null> {
  const stat = await ctx.adapter.stat(path);
  if (!stat || stat.path !== path) return null;
  const data = await ctx.adapter.read(path);
  return data ? { data, stat } : null;
}

/** A record only counts as "this device has version X here" when the file is really written locally. */
export function isSyncedHere(rec: FileRecord | undefined): rec is FileRecord & { versionId: string } {
  return !!rec && rec.versionId !== null && !rec.shadowed && !rec.ignored && !rec.tooLarge;
}

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
 * failures.ts) are recorded and skipped; only cycle errors are thrown.
 */
export async function applyVersion(ctx: SyncContext, v: RemoteVersion): Promise<void> {
  const fileId = toHex(v.fileId);
  try {
    await applyOne(ctx, v, fileId);
    await clearFailure(ctx, applyKey(fileId));
  } catch (err) {
    if (isCycleError(err)) throw err;
    let path = fileId;
    try {
      path = (await decryptMeta(ctx.ring, v.epoch, v.fileId, v.versionId, v.encMeta)).path;
    } catch {
      // keep the id
    }
    await recordFailure(ctx, applyKey(fileId), path, err);
  }
}

async function applyOne(ctx: SyncContext, v: RemoteVersion, fileId: string): Promise<void> {
  const versionId = toHex(v.versionId);
  const stored = await ctx.state.getFile(fileId);
  if (alreadyApplied(stored, versionId, ctx)) return;
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
    await ctx.state.recordSynced(record(fileId, path, versionId, v, contentHash, -1, { tooLarge: true }), null);
    ctx.emit({ type: 'notice', code: 'TOO_LARGE', persistent: true, path, message: `${path} (${v.size} bytes) is larger than this device syncs and was not downloaded` });
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
        const copy = await freeConflictPath(ctx, path, meta.deviceName || 'unknown device');
        if (!(await adapter.write(copy, await remote(), { absent: true }))) return false;
        await state.markDirty(copy);
        ctx.emit({ type: 'notice', code: 'CASE_COLLISION', persistent: false, path, message: `${path} differs only in letter case from ${st.path}; this device saved it as ${copy}` });
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
