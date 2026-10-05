// Push (spec §5.3): turn dirty paths into commits, upload missing chunks,
// commit in batches, and handle each result.
import { toBinary, create } from '@bufbuild/protobuf';
import { ApiError, ErrorCode } from '../api/errors';
import { COMMIT_BATCH_BYTES, MAX_CHUNK_EXISTS_BATCH, MAX_COMMITS_PER_REQUEST } from '../api/limits';
import type { CommitInput } from '../api/types';
import { encryptChunk, encryptMeta, fileIdFor } from '../crypto/objects';
import { epochKeys } from '../crypto/vaultkeys';
import { CommitSchema } from '../gen/obsync/v1/obsync_pb';
import type { DirtyEntry, PendingCommit } from '../state/store';
import { fromHex, toHex } from '../util/bytes';
import { InvalidPathError, normalizePath } from '../util/path';
import { isSyncedHere, readLocal } from './apply';
import { decodeText, hashHex, prepareContent, splitChunks } from './content';
import type { SyncContext } from './context';
import { applyKey, clearFailure, isCycleError, isDeferred, pushKey, recordFailure } from './failures';
import { pull, resolveConflict } from './pull';

/** Bounds one push round so memory stays small; the engine runs rounds until nothing is left. */
export const MAX_FILES_PER_ROUND = 200;
export const MAX_BYTES_PER_ROUND = 64 << 20;

/** Push bookkeeping that lives as long as the engine. */
export class PushMemory {
  /** fileId → MISSING_CHUNK results seen for its pending commit. */
  readonly missingChunk = new Map<string, number>();
}

export interface PushResult {
  /** Dirty entries were looked at (false: nothing to do). */
  worked: boolean;
  /**
   * Dirty entries actually worked on: not waiting out a failure's backoff
   * (their own push failure, or an apply failure of the file's remote
   * version, which a push could only conflict with). 0 means another
   * round now would do nothing.
   */
  attempted: number;
  committed: number;
  conflicts: number;
  /** A STALE_EPOCH result: the keyring must be refreshed before pushing again. */
  staleEpoch: boolean;
}

interface Op {
  entry: DirtyEntry;
  pending: PendingCommit;
  /** The content the pending commit was built from, when known. */
  data: Uint8Array | null;
  /** The pending commit describes the local file as it was when the entry was read. */
  matchesLocal: boolean;
  statMtime: number;
}

/** Splits commits so each request stays under the server's count and body limits. */
export function batchCommits<T extends CommitInput>(commits: T[], maxCount = MAX_COMMITS_PER_REQUEST, maxBytes = COMMIT_BATCH_BYTES): T[][] {
  const batches: T[][] = [];
  let cur: T[] = [];
  let bytes = 0;
  for (const c of commits) {
    const size = toBinary(CommitSchema, create(CommitSchema, { ...c, size: BigInt(c.size) })).length + 8;
    if (cur.length > 0 && (cur.length >= maxCount || bytes + size > maxBytes)) {
      batches.push(cur);
      cur = [];
      bytes = 0;
    }
    cur.push(c);
    bytes += size;
  }
  if (cur.length > 0) batches.push(cur);
  return batches;
}

function toCommit(p: PendingCommit): CommitInput {
  return {
    fileId: fromHex(p.fileId), versionId: fromHex(p.versionId), baseVersionId: fromHex(p.baseVersionId), epoch: p.epoch,
    encMeta: p.encMeta, chunkIds: p.chunkIds, size: p.size, deleted: p.deleted,
  };
}

/**
 * Builds the op for one dirty entry, or null when there is nothing to
 * commit (the entry is then cleared), or 'wait' when the entry must wait
 * (it stays dirty and is not worked on this round).
 */
async function buildOp(ctx: SyncContext, entry: DirtyEntry): Promise<Op | null | 'wait'> {
  const { state, ring } = ctx;
  let path: string;
  try {
    path = normalizePath(entry.path);
  } catch (err) {
    if (!(err instanceof InvalidPathError)) throw err;
    ctx.emit({ type: 'notice', code: 'INVALID_PATH', persistent: false, path: entry.path, message: err.message });
    await state.clearDirty(entry.path, entry.gen);
    return null;
  }
  if (ctx.ignore.matches(path)) {
    await state.clearDirty(entry.path, entry.gen);
    return null;
  }
  const fileIdBytes = await fileIdFor(ring.namingKey, path);
  const fileId = toHex(fileIdBytes);
  // The file's remote version failed to apply and waits out its backoff: a
  // commit could only conflict with that version, so wait for it too.
  if (await isDeferred(ctx, applyKey(fileId))) return 'wait';
  const rec = await state.getFile(fileId);
  const synced = isSyncedHere(rec);
  const base = synced ? rec.versionId : '';
  const pending = await state.getPending(fileId);
  if (pending) {
    // Resend a pending commit unchanged only while the file's record still
    // sits on its base. If a pull moved the record (to the pending version
    // itself, because it landed and came back, or to a newer one), the
    // pending commit is settled or stale; resending it could "succeed" as
    // an idempotent retry of an old version and leave this device behind.
    if (base === pending.baseVersionId) return { entry, pending, data: null, matchesLocal: false, statMtime: -1 };
    await state.deletePending(fileId);
  }
  if (rec?.shadowed || rec?.tooLarge) {
    // Not written here (case collision, or the remote version is over this
    // device's size limit): never push this device's state over it.
    await state.clearDirty(entry.path, entry.gen);
    return null;
  }
  const stat = await ctx.adapter.stat(path);
  const refusal = await state.getRefusal(path);
  if (stat && stat.path === path && stat.size > ctx.maxFileBytes) {
    const fingerprint = `stat:${stat.size}:${stat.mtime}`;
    if (refusal?.fingerprint !== fingerprint) {
      await state.putRefusal({ path, fingerprint, message: `larger than ${ctx.maxFileBytes} bytes` });
      ctx.emit({ type: 'notice', code: 'TOO_LARGE', persistent: true, path, message: `${path} (${stat.size} bytes) is larger than this device syncs and was not uploaded` });
    }
    await state.clearDirty(entry.path, entry.gen);
    return null;
  }
  const local = await readLocal(ctx, path);
  const keys = epochKeys(ring, ring.currentEpoch);
  const versionId = ctx.random.bytes(16);

  if (!local) {
    if (!synced || rec.deleted) {
      await state.clearDirty(entry.path, entry.gen);
      return null;
    }
    const meta = { path, mtimeMs: ctx.clock.now(), size: 0, contentHash: new Uint8Array(0), renamedFrom: '', deviceName: ctx.deviceName };
    const p: PendingCommit = {
      fileId, path, versionId: toHex(versionId), baseVersionId: base, epoch: keys.epoch,
      encMeta: await encryptMeta(ctx.random, ring.vaultId, keys, fileIdBytes, versionId, meta),
      chunkIds: [], size: 0, deleted: true, contentHash: null, mtime: meta.mtimeMs, text: null,
    };
    await state.putPending(p);
    return { entry, pending: p, data: null, matchesLocal: true, statMtime: -1 };
  }

  const hash = await hashHex(local.data);
  if (synced && !rec.deleted && rec.contentHash === hash) {
    if (rec.localMtime !== local.stat.mtime) await state.putFile({ ...rec, localMtime: local.stat.mtime });
    await state.clearDirty(entry.path, entry.gen);
    return null;
  }
  if (refusal?.fingerprint === hash) {
    await state.clearDirty(entry.path, entry.gen);
    return null;
  }
  const prep = await prepareContent(keys, local.data);
  let renamedFrom = '';
  if (entry.renamedFrom && entry.renamedFrom !== path) {
    try {
      renamedFrom = normalizePath(entry.renamedFrom);
    } catch {
      renamedFrom = '';
    }
  }
  const meta = { path, mtimeMs: local.stat.mtime, size: prep.size, contentHash: prep.contentHash, renamedFrom, deviceName: ctx.deviceName };
  const p: PendingCommit = {
    fileId, path, versionId: toHex(versionId), baseVersionId: base, epoch: keys.epoch,
    encMeta: await encryptMeta(ctx.random, ring.vaultId, keys, fileIdBytes, versionId, meta),
    chunkIds: prep.chunkIds, size: prep.size, deleted: false, contentHash: hash, mtime: local.stat.mtime,
    text: decodeText(path, local.data),
  };
  await state.putPending(p);
  return { entry, pending: p, data: local.data, matchesLocal: true, statMtime: local.stat.mtime };
}

/** Uploads every chunk the server lacks. Ops whose content can no longer be produced are dropped (and rebuilt next round). */
async function uploadChunks(ctx: SyncContext, ops: Op[]): Promise<Op[]> {
  const wanted: Array<{ id: Uint8Array; op: Op; idx: number }> = [];
  const seen = new Set<string>();
  for (const op of ops) {
    op.pending.chunkIds.forEach((id, idx) => {
      const k = toHex(id);
      if (!seen.has(k)) {
        seen.add(k);
        wanted.push({ id, op, idx });
      }
    });
  }
  const dropped = new Set<Op>();
  const keys = (epoch: number) => epochKeys(ctx.ring, epoch);
  for (let i = 0; i < wanted.length; i += MAX_CHUNK_EXISTS_BATCH) {
    const batch = wanted.slice(i, i + MAX_CHUNK_EXISTS_BATCH);
    const exists = await ctx.api.chunksExist(ctx.ring.vaultId, batch.map((w) => w.id));
    for (let j = 0; j < batch.length; j++) {
      const w = batch[j]!;
      if (exists[j] || dropped.has(w.op)) continue;
      if (!w.op.data) {
        // A pending commit from before a restart: its content must still be
        // on disk. A file whose size changed is not even read (it may be
        // huge now): the pending commit is stale either way.
        const p = w.op.pending;
        let local: Awaited<ReturnType<typeof readLocal>>;
        try {
          const st = await ctx.adapter.stat(p.path);
          local = st && st.path === p.path && st.size === p.size && st.size <= ctx.maxFileBytes ? await readLocal(ctx, p.path) : null;
        } catch (err) {
          if (isCycleError(err)) throw err;
          await recordFailure(ctx, pushKey(w.op.pending.path), w.op.pending.path, err);
          local = null;
        }
        if (!local || (await hashHex(local.data)) !== w.op.pending.contentHash) {
          await ctx.state.deletePending(w.op.pending.fileId);
          dropped.add(w.op);
          continue;
        }
        w.op.data = local.data;
      }
      const chunk = splitChunks(w.op.data)[w.idx]!;
      const sealed = await encryptChunk(ctx.random, ctx.ring.vaultId, keys(w.op.pending.epoch), w.id, chunk);
      await ctx.api.putChunk(ctx.ring.vaultId, w.id, sealed);
    }
  }
  return ops.filter((op) => !dropped.has(op));
}

/** One push round over up to MAX_FILES_PER_ROUND dirty paths. */
export async function pushRound(ctx: SyncContext, mem: PushMemory): Promise<PushResult> {
  const result: PushResult = { worked: false, attempted: 0, committed: 0, conflicts: 0, staleEpoch: false };
  const entries = (await ctx.state.dirtyEntries()).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  if (entries.length === 0) return result;
  result.worked = true;

  let ops: Op[] = [];
  let bytes = 0;
  const fileIds = new Set<string>();
  for (const entry of entries) {
    if (ops.length >= MAX_FILES_PER_ROUND || bytes >= MAX_BYTES_PER_ROUND) break;
    if (await isDeferred(ctx, pushKey(entry.path))) continue;
    let op: Op | null | 'wait';
    try {
      op = await buildOp(ctx, entry);
    } catch (err) {
      // One unreadable file must not stop the others (failures.ts).
      if (isCycleError(err)) throw err;
      result.attempted++;
      await recordFailure(ctx, pushKey(entry.path), entry.path, err);
      continue;
    }
    if (op === 'wait') continue;
    result.attempted++;
    await clearFailure(ctx, pushKey(entry.path));
    if (!op || fileIds.has(op.pending.fileId)) continue;
    fileIds.add(op.pending.fileId);
    ops.push(op);
    bytes += op.pending.size;
  }
  if (ops.length === 0) return result;
  // Deletions first: a case-only rename (todo.md → TODO.md) must free the
  // old name before the new one exists for case-insensitive peers.
  ops.sort((a, b) => Number(b.pending.deleted) - Number(a.pending.deleted));

  ops = await uploadChunks(ctx, ops);
  const conflicts: Array<{ fileId: Uint8Array; head: Uint8Array }> = [];
  const byFile = new Map(ops.map((op) => [op.pending.fileId, op]));
  let unexpected: ApiError | null = null;
  for (const batch of batchCommits(ops.map((op) => toCommit(op.pending)))) {
    const reply = await ctx.api.commit(ctx.ring.vaultId, batch);
    for (const r of reply.results) {
      const op = byFile.get(toHex(r.fileId))!;
      const p = op.pending;
      if (r.ok) {
        result.committed++;
        mem.missingChunk.delete(p.fileId);
        await ctx.state.recordSynced(
          { fileId: p.fileId, path: p.path, versionId: p.versionId, deleted: p.deleted, contentHash: p.contentHash, size: p.size, localMtime: op.matchesLocal ? op.statMtime : -1, hasBase: false, seq: r.seq },
          p.text,
          true,
        );
        await ctx.state.deleteRefusal(p.path);
        if (op.matchesLocal) await ctx.state.clearDirty(op.entry.path, op.entry.gen);
        continue;
      }
      const code = r.error?.code ?? ErrorCode.INTERNAL;
      switch (code) {
        case ErrorCode.CONFLICT:
          result.conflicts++;
          await ctx.state.deletePending(p.fileId);
          conflicts.push({ fileId: r.fileId, head: r.headVersionId });
          break;
        case ErrorCode.MISSING_CHUNK: {
          // Keep the pending commit; the next round's exists check uploads the chunk again.
          const n = (mem.missingChunk.get(p.fileId) ?? 0) + 1;
          mem.missingChunk.set(p.fileId, n);
          if (n >= 3) {
            await ctx.state.deletePending(p.fileId);
            mem.missingChunk.delete(p.fileId);
          }
          break;
        }
        case ErrorCode.STALE_EPOCH:
          await ctx.state.deletePending(p.fileId);
          result.staleEpoch = true;
          break;
        case ErrorCode.TOO_LARGE:
        case ErrorCode.INVALID: {
          // Not retried until the file changes.
          await ctx.state.deletePending(p.fileId);
          await ctx.state.putRefusal({ path: p.path, fingerprint: p.contentHash ?? 'deleted', message: r.error?.message ?? 'rejected' });
          // A resent pending commit may describe an older state of the
          // file: then the entry stays and the next round looks at the file
          // as it is now (the refusal only covers the refused content).
          if (op.matchesLocal) await ctx.state.clearDirty(op.entry.path, op.entry.gen);
          ctx.emit({
            type: 'notice', code: code === ErrorCode.TOO_LARGE ? 'TOO_LARGE' : 'COMMIT_REJECTED', persistent: code === ErrorCode.TOO_LARGE,
            path: p.path, message: `${p.path} was not synced: ${r.error?.message ?? 'rejected by the server'}`,
          });
          break;
        }
        default:
          // A code the server does not send for one commit (or none at all):
          // keep the pending commit and fail the cycle, which backs off and
          // resends it, rather than refusing the file for good.
          unexpected ??= new ApiError(code, r.error?.message || 'unexpected commit result', 200);
      }
    }
  }
  if (conflicts.length > 0) {
    await pull(ctx);
    for (const c of conflicts) await resolveConflict(ctx, c.fileId, c.head);
  }
  if (unexpected) throw unexpected;
  return result;
}
