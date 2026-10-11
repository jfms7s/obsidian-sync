// Pull (spec §5.4): page through the change log from the cursor and apply
// each file's newest version in the page. Also: noticing a server that was
// restored from a backup.
import { CHANGES_PAGE_SIZE, HEADS_PAGE_SIZE } from '../api/limits';
import type { RemoteHead, RemoteVersion } from '../api/types';
import type { FileRecord } from '../state/store';
import { decryptMeta } from '../crypto/objects';
import { toHex } from '../util/bytes';
import { alreadyApplied, applyHead, ensureHeadApplied } from './apply';
import { downloadContent } from './content';
import { ServerRollbackError, type SyncContext } from './context';

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
export async function serverLostHistory(ctx: SyncContext, heads?: RemoteHead[], records?: Iterable<FileRecord>): Promise<boolean> {
  const byFile = new Map((heads ?? (await remoteHeads(ctx))).map((h) => [toHex(h.fileId), h]));
  for (const rec of records ?? (await ctx.state.allFiles())) {
    if (rec.versionId === null || !rec.seq) continue;
    const head = byFile.get(rec.fileId);
    // The same seq with another version: the server was restored and its new commits reused the seq.
    if (!head || head.seq < rec.seq || (head.seq === rec.seq && toHex(head.versionId) !== rec.versionId)) return true;
  }
  return false;
}

/** Whether a synced record sits at the seq of one of versions with another version id (one read for the page). */
async function seqReused(ctx: SyncContext, versions: readonly RemoteVersion[]): Promise<boolean> {
  if (versions.length === 0) return false;
  const atSeq = new Map<number, string>(versions.map((v) => [v.seq, toHex(v.versionId)]));
  return (await ctx.state.filesAtSeqs([...atSeq.keys()])).some((r) => r.versionId !== atSeq.get(r.seq));
}

/** How many versions of a page download at once, the one being applied included. */
export const PREFETCH_VERSIONS = 4;
/** Content bytes downloaded ahead of the apply at most; a larger version is downloaded when its turn comes. */
export const PREFETCH_BYTES = 32 << 20;

/**
 * Downloads the content of the next few versions of a page while the
 * current one is applied: on a first sync the network round trips overlap
 * instead of adding up. Applying stays in order; only versions whose apply
 * will need the content are fetched (not deleted, not ignored, within the
 * size limit, and not already this device's), within PREFETCH_BYTES.
 */
class Prefetch {
  private readonly started = new Map<number, Promise<Uint8Array>>();
  private readonly hashes = new Map<number, Uint8Array | null>();

  constructor(private readonly ctx: SyncContext, private readonly heads: readonly RemoteVersion[]) {}

  /** Makes sure the downloads for heads[i] onwards (PREFETCH_VERSIONS of them, within PREFETCH_BYTES) have started. */
  async startFrom(i: number): Promise<void> {
    let bytes = 0;
    for (const [j] of this.started) if (j >= i) bytes += this.heads[j]!.size;
    for (let j = i; j < Math.min(i + PREFETCH_VERSIONS, this.heads.length); j++) {
      if (this.started.has(j)) continue;
      const v = this.heads[j]!;
      if (bytes + v.size > PREFETCH_BYTES) break;
      const contentHash = await this.wanted(j);
      if (!contentHash) continue;
      const p = downloadContent(this.ctx.api, this.ctx.ring, v, contentHash);
      p.catch(() => undefined); // its apply sees the error; one never taken must not be an unhandled rejection
      this.started.set(j, p);
      bytes += v.size;
    }
  }

  /** The download started for heads[i], if any; it is the caller's from now on. */
  take(i: number): Promise<Uint8Array> | undefined {
    const p = this.started.get(i);
    this.started.delete(i);
    return p;
  }

  /** The content hash to download heads[j] against, or null when its apply will not need the content. */
  private async wanted(j: number): Promise<Uint8Array | null> {
    let hash = this.hashes.get(j);
    if (hash === undefined) {
      hash = await this.contentHashIfNeeded(this.heads[j]!);
      this.hashes.set(j, hash);
    }
    return hash;
  }

  private async contentHashIfNeeded(v: RemoteVersion): Promise<Uint8Array | null> {
    const { ctx } = this;
    if (v.deleted || v.size === 0 || v.size > ctx.maxFileBytes) return null;
    const fileId = toHex(v.fileId);
    const versionId = toHex(v.versionId);
    const rec = await ctx.state.getFile(fileId);
    if (alreadyApplied(rec, versionId, ctx) || (rec?.versionId != null && rec.seq > v.seq)) return null;
    if ((await ctx.state.getPending(fileId))?.versionId === versionId) return null; // this device's own commit
    let meta: Awaited<ReturnType<typeof decryptMeta>>;
    try {
      meta = await decryptMeta(ctx.ring, v.epoch, v.fileId, v.versionId, v.encMeta);
    } catch {
      return null; // its apply reports it
    }
    if (ctx.ignore.matches(meta.path) || meta.contentHash.length !== 32) return null;
    return meta.contentHash;
  }
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
    // A seq names one version. A different synced version at the same seq
    // (this device's own commit, say, that it has not pulled yet) means the
    // server was restored from a backup and its new commits reused the seq.
    if (await seqReused(ctx, versions)) throw new ServerRollbackError(cursor, page.vaultSeq);
    const heads = newestPerFile(versions);
    const ahead = new Prefetch(ctx, heads);
    for (let i = 0; i < heads.length; i++) {
      await ahead.startFrom(i);
      await applyHead(ctx, heads[i]!, versions, ahead.take(i));
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

/** After a commit got CONFLICT: make sure the server's head for the file is applied locally, so the next push merges against it. */
export async function resolveConflict(ctx: SyncContext, fileId: Uint8Array, head: Uint8Array): Promise<void> {
  const hex = toHex(fileId);
  const rec = await ctx.state.getFile(hex);
  if (head.length === 0) {
    // The server has no such file (it lost history); push it as new.
    if (rec) await ctx.state.putFile({ ...rec, versionId: null, contentHash: null, localMtime: -1, seq: 0 });
    return;
  }
  // A failed apply waits out its backoff: retried by reconcile, not by every push round.
  await ensureHeadApplied(ctx, fileId, head, rec);
}
