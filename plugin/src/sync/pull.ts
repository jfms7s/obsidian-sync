// Pull (spec §5.4): page through the change log from the cursor and apply
// each file's newest version in the page. Also: noticing a server that was
// restored from a backup.
import { CHANGES_PAGE_SIZE, HEADS_PAGE_SIZE } from '../api/limits';
import type { RemoteHead, RemoteVersion } from '../api/types';
import { equalBytes, toHex } from '../util/bytes';
import { alreadyApplied, applyHead } from './apply';
import { ServerRollbackError, type SyncContext } from './context';
import { applyKey, isDeferred } from './failures';

export interface PullResult {
  applied: number;
  vaultSeq: number;
}

/**
 * Keeps the last version of each file, deletions first, then in seq order.
 * Deletions go first so a case-only rename (todo.md → TODO.md) frees the old
 * name before the new one is written on a case-insensitive file system.
 */
export function newestPerFile(versions: RemoteVersion[]): RemoteVersion[] {
  const last = new Map<string, RemoteVersion>();
  for (const v of versions) last.set(toHex(v.fileId), v);
  return [...last.values()].sort((a, b) => Number(b.deleted) - Number(a.deleted) || a.seq - b.seq);
}

export async function remoteHeads(ctx: SyncContext, pageSize = HEADS_PAGE_SIZE): Promise<RemoteHead[]> {
  const out: RemoteHead[] = [];
  let after: Uint8Array | null = null;
  for (;;) {
    const page = await ctx.api.heads(ctx.ring.vaultId, after, pageSize);
    out.push(...page.heads);
    const last = page.heads.at(-1);
    if (!page.more || !last) return out;
    after = last.fileId;
  }
}

/**
 * Whether the server lost history this device saw. Heads never move
 * backwards and are never removed (tombstones stay), so a file this device
 * synced at seq s whose head is now missing, older than s, or another
 * version at s means the server was restored from a backup. Independent of the vault's seq, which
 * other devices may have pushed past the lost range again.
 */
export async function serverLostHistory(ctx: SyncContext, heads?: RemoteHead[]): Promise<boolean> {
  const byFile = new Map((heads ?? (await remoteHeads(ctx))).map((h) => [toHex(h.fileId), h]));
  for (const rec of await ctx.state.allFiles()) {
    if (rec.versionId === null || !rec.seq) continue;
    const head = byFile.get(rec.fileId);
    // The same seq with another version: the server was restored and its new commits reused the seq.
    if (!head || head.seq < rec.seq || (head.seq === rec.seq && toHex(head.versionId) !== rec.versionId)) return true;
  }
  return false;
}

/**
 * Pulls from the cursor. The version at the cursor (the "anchor") is asked
 * for again (since = cursor − 1): if the server now has a different version
 * at that seq, or none, it may have lost history. Pruning can also remove
 * the anchor, so that only triggers the heads check, which decides.
 */
export async function pull(ctx: SyncContext, pageSize = CHANGES_PAGE_SIZE): Promise<PullResult> {
  const { state } = ctx;
  let cursor = await state.getCursor();
  let anchor = await state.getCursorAnchor();
  let checkAnchor = anchor !== null && anchor.seq === cursor && cursor > 0;
  let applied = 0;
  for (;;) {
    const since = checkAnchor ? cursor - 1 : cursor;
    const page = await ctx.api.changes(ctx.ring.vaultId, since, pageSize);
    // A synced version above the server's seq cannot exist on a server that
    // kept its history: the cursor alone misses this after a crash left it behind its records.
    if (page.vaultSeq < cursor || (await state.maxFileSeq()) > page.vaultSeq) throw new ServerRollbackError(cursor, page.vaultSeq);
    let versions = page.versions;
    if (checkAnchor) {
      checkAnchor = false;
      const first = versions[0];
      const same = first !== undefined && first.seq === cursor && toHex(first.versionId) === anchor!.versionId;
      // Only the anchor itself was applied already; another version at
      // that seq (heads agreeing, below) has not been, so it stays.
      if (same) versions = versions.slice(1);
      if (!same) {
        if (await serverLostHistory(ctx)) throw new ServerRollbackError(cursor, page.vaultSeq);
        // Only pruned: stop checking until the cursor moves to a new anchor.
        anchor = null;
        await state.setCursorAnchor(null);
      }
    }
    for (const v of newestPerFile(versions)) {
      await applyHead(ctx, v, versions);
      applied++;
    }
    const last = versions.at(-1);
    const next = Math.max(cursor, last?.seq ?? 0, page.more ? 0 : page.vaultSeq);
    if (next !== cursor) {
      cursor = next;
      anchor = last && last.seq === cursor ? { seq: cursor, versionId: toHex(last.versionId) } : null;
      // Saved only after the whole page is applied, so a failure part-way
      // re-reads the page (applying is idempotent).
      await state.setCursorAndAnchor(cursor, anchor);
    }
    if (!page.more) return { applied, vaultSeq: page.vaultSeq };
  }
}

/**
 * After a commit got CONFLICT: make sure the server's head for the file
 * has been applied locally, so the next push merges against it. The
 * history also reveals a landed pending commit of this device's that the
 * head overtook (applyHead).
 */
export async function resolveConflict(ctx: SyncContext, fileId: Uint8Array, head: Uint8Array): Promise<void> {
  const hex = toHex(fileId);
  const rec = await ctx.state.getFile(hex);
  if (head.length === 0) {
    // The server has no such file (it lost history); push it as new.
    if (rec) await ctx.state.putFile({ ...rec, versionId: null, contentHash: null, localMtime: -1, seq: 0 });
    return;
  }
  // Already applied, or its apply failed and waits out the backoff (retried by reconcile, not by every push round).
  if (alreadyApplied(rec, toHex(head), ctx) || (await isDeferred(ctx, applyKey(hex)))) return;
  const versions = await ctx.api.history(ctx.ring.vaultId, fileId);
  const v = versions.find((x) => equalBytes(x.versionId, head));
  if (v) await applyHead(ctx, v, versions);
}
