// Reconcile (spec §5.6): compare the server's heads and the local file
// system with local state, and queue whatever events missed.
import { fileIdFor } from '../crypto/objects';
import { toHex } from '../util/bytes';
import { normalizePath } from '../util/path';
import { mapConcurrently } from '../util/pool';
import { isCoarseMtime, type FileStat } from '../vault/adapter';
import { ensureHeadApplied, isSyncedHere } from './apply';
import { hashHex } from './content';
import type { FileRecord } from '../state/store';
import { ServerRollbackError, type SyncContext } from './context';
import { forgetHeldPresent, heldDeletions } from './deletion-hold';
import { isCycleError } from './failures';
import { pull, remoteHeads, serverLostHistory } from './pull';

export interface ReconcileResult {
  fetched: number;
  markedDirty: number;
  /** The vault seq its pull saw. */
  vaultSeq: number;
  /** Files not written locally because another file or a folder holds their name. */
  shadowed: number;
}

/** How many local files reconcile looks up (file id and stat) at a time. */
export const RECONCILE_CONCURRENCY = 8;

/** One local file as step 2 of reconcile found it; st is only looked up for a file synced here. */
interface LocalLook {
  path: string;
  fileId: string;
  rec: FileRecord | undefined;
  st?: FileStat | null;
  /** The stat threw (not a cycle error, which fails the reconcile). */
  statFailed?: boolean;
}

/**
 * Equal size and mtime mean unchanged, except where mtimes are whole
 * seconds (FAT keeps even two-second steps): there an edit saved in the
 * same step as the one recorded keeps both. It cannot have happened unseen
 * once the record's content was checked (localCheckedAt, taken before that
 * read or write) more than two seconds after its mtime: any later edit
 * gets a later mtime. Records written within that window, and records
 * from before localCheckedAt was kept, are read and compared once more.
 */
function settled(rec: FileRecord, mtime: number): boolean {
  return rec.localCheckedAt !== undefined && rec.localCheckedAt - mtime > 2000;
}

export async function reconcile(ctx: SyncContext): Promise<ReconcileResult> {
  const { state, adapter } = ctx;
  const { vaultSeq } = await pull(ctx);
  let fetched = 0;
  let markedDirty = 0;

  // 0. A server restored from a backup (whatever its seq says now).
  const heads = await remoteHeads(ctx);
  const before = new Map((await state.allFiles()).map((r) => [r.fileId, r]));
  if (await serverLostHistory(ctx, heads, before.values())) {
    // A loop, not Math.max(...): spreading 125,000+ heads overflows the call stack.
    let top = 0;
    for (const h of heads) if (h.seq > top) top = h.seq;
    throw new ServerRollbackError(await state.getCursor(), top);
  }

  // 1. Remote heads this device has not applied (failed files after their
  // backoff). The records from before step 1 do: each head is another file,
  // and one applied here is not looked at again in this step.
  for (const head of heads) {
    if (await ensureHeadApplied(ctx, head.fileId, head.versionId, before.get(toHex(head.fileId)))) fetched++;
  }

  // 2. Local files that are new or changed without an event. Step 1 changed
  // records, so they are loaded again. File ids and stats are worked out a
  // few at a time (each stat is a bridge hop on mobile); the results are
  // then taken in path order, so dirty entries get their generations in
  // the same order as before.
  const records = new Map((await state.allFiles()).map((r) => [r.fileId, r]));
  const present = new Set<string>();
  let shadowed = 0;
  const paths: string[] = [];
  // A folder the ignore rules match is skipped whole (so is everything in it).
  for (const raw of await adapter.list((folder) => ctx.ignore.matches(`${folder}/`))) {
    let path: string;
    try {
      path = normalizePath(raw);
    } catch {
      continue;
    }
    if (!ctx.ignore.matches(path)) paths.push(path);
  }
  const looked = await mapConcurrently(paths, RECONCILE_CONCURRENCY, async (path): Promise<LocalLook> => {
    const fileId = toHex(await fileIdFor(ctx.ring.namingKey, path));
    const rec = records.get(fileId);
    if (rec?.shadowed || !isSyncedHere(rec) || rec.deleted) return { path, fileId, rec };
    try {
      return { path, fileId, rec, st: await adapter.stat(path) };
    } catch (err) {
      if (isCycleError(err)) throw err;
      return { path, fileId, rec, statFailed: true };
    }
  });
  for (const { path, fileId, rec, st, statFailed } of looked) {
    present.add(fileId);
    if (rec?.shadowed) continue;
    if (!isSyncedHere(rec) || rec.deleted) {
      await state.markDirty(path);
      markedDirty++;
      continue;
    }
    if (statFailed) {
      // One unreadable file must not fail the cycle: push reports it for this file.
      await state.markDirty(path);
      markedDirty++;
      continue;
    }
    if (!st || (st.mtime === rec.localMtime && st.size === rec.size && (!isCoarseMtime(st.mtime) || settled(rec, st.mtime)))) continue;
    if (st.size !== rec.size) {
      // Changed for sure: push reads it (or refuses it when too large).
      await state.markDirty(path);
      markedDirty++;
      continue;
    }
    // Same size, new mtime (a touch, or a sync tool that rewrote it), or a
    // whole-second mtime not settled yet: read and compare.
    const checkedAt = ctx.clock.now();
    let data: Uint8Array | null;
    try {
      data = await adapter.read(path);
    } catch (err) {
      if (isCycleError(err)) throw err;
      data = null; // push reports the read error for this file
    }
    if (data && (await hashHex(data)) === rec.contentHash) {
      await state.putFile({ ...rec, localMtime: st.mtime, localCheckedAt: checkedAt });
    } else {
      await state.markDirty(path);
      markedDirty++;
    }
  }

  // 3. Synced files that disappeared without an event; not those on hold
  // (deletion-hold.ts): they wait for the user, and the ones that are back
  // here leave the hold.
  const held = new Set(await heldDeletions(state));
  if (held.size > 0) {
    const presentPaths = new Set([...records.values()].filter((r) => present.has(r.fileId)).map((r) => r.path));
    await forgetHeldPresent(state, (p) => presentPaths.has(p));
  }
  for (const rec of records.values()) {
    if (isSyncedHere(rec) && !rec.deleted && !present.has(rec.fileId) && !held.has(rec.path)) {
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
  for (const rec of records.values()) if (rec.shadowed) shadowed++;
  return { fetched, markedDirty, vaultSeq, shadowed };
}
