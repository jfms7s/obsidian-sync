// Reconcile (spec §5.6): compare the server's heads and the local file
// system with local state, and queue whatever events missed.
import { fileIdFor } from '../crypto/objects';
import { equalBytes, toHex } from '../util/bytes';
import { normalizePath } from '../util/path';
import { alreadyApplied, applyHead, isSyncedHere } from './apply';
import { hashHex } from './content';
import { ServerRollbackError, type SyncContext } from './context';
import { applyKey, isCycleError, isDeferred } from './failures';
import { pull, remoteHeads, serverLostHistory } from './pull';

export interface ReconcileResult {
  fetched: number;
  markedDirty: number;
  /** The vault seq its pull saw. */
  vaultSeq: number;
}

export async function reconcile(ctx: SyncContext): Promise<ReconcileResult> {
  const { state, adapter } = ctx;
  const { vaultSeq } = await pull(ctx);
  let fetched = 0;
  let markedDirty = 0;

  // 0. A server restored from a backup (whatever its seq says now).
  const heads = await remoteHeads(ctx);
  if (await serverLostHistory(ctx, heads)) {
    throw new ServerRollbackError(await state.getCursor(), Math.max(0, ...heads.map((h) => h.seq)));
  }

  // 1. Remote heads this device has not applied (failed files after their backoff).
  for (const head of heads) {
    const fileId = toHex(head.fileId);
    const rec = await state.getFile(fileId);
    if (alreadyApplied(rec, toHex(head.versionId), ctx) || (await isDeferred(ctx, applyKey(fileId)))) continue;
    const history = await ctx.api.history(ctx.ring.vaultId, head.fileId);
    const v = history.find((x) => equalBytes(x.versionId, head.versionId));
    if (v) {
      // The history also reveals a landed pending commit the head overtook (applyHead).
      await applyHead(ctx, v, history);
      fetched++;
    }
  }

  // 2. Local files that are new or changed without an event.
  const records = new Map((await state.allFiles()).map((r) => [r.fileId, r]));
  const present = new Set<string>();
  for (const raw of await adapter.list()) {
    let path: string;
    try {
      path = normalizePath(raw);
    } catch {
      continue;
    }
    if (ctx.ignore.matches(path)) continue;
    const fileId = toHex(await fileIdFor(ctx.ring.namingKey, path));
    present.add(fileId);
    const rec = records.get(fileId);
    if (rec?.shadowed) continue;
    if (!isSyncedHere(rec) || rec.deleted) {
      await state.markDirty(path);
      markedDirty++;
      continue;
    }
    let st: Awaited<ReturnType<typeof adapter.stat>>;
    try {
      st = await adapter.stat(path);
    } catch (err) {
      // One unreadable file must not fail the cycle: push reports it for this file.
      if (isCycleError(err)) throw err;
      await state.markDirty(path);
      markedDirty++;
      continue;
    }
    if (!st || (st.mtime === rec.localMtime && st.size === rec.size)) continue;
    if (st.size !== rec.size) {
      // Changed for sure: push reads it (or refuses it when too large).
      await state.markDirty(path);
      markedDirty++;
      continue;
    }
    // Same size, new mtime: read and compare (a touch, or a sync tool that rewrote it).
    let data: Uint8Array | null;
    try {
      data = await adapter.read(path);
    } catch (err) {
      if (isCycleError(err)) throw err;
      data = null; // push reports the read error for this file
    }
    if (data && (await hashHex(data)) === rec.contentHash) {
      await state.putFile({ ...rec, localMtime: st.mtime });
    } else {
      await state.markDirty(path);
      markedDirty++;
    }
  }

  // 3. Synced files that disappeared without an event.
  for (const rec of records.values()) {
    if (isSyncedHere(rec) && !rec.deleted && !present.has(rec.fileId)) {
      await state.markDirty(rec.path);
      markedDirty++;
    }
  }

  // 4. Pending commits whose dirty entry was lost.
  const dirty = new Set((await state.dirtyEntries()).map((e) => e.path));
  for (const p of await state.allPending()) {
    if (!dirty.has(p.path)) {
      await state.markDirty(p.path);
      markedDirty++;
    }
  }
  return { fetched, markedDirty, vaultSeq };
}
