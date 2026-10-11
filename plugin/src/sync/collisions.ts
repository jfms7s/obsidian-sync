// A file and a folder cannot share a path, and on a case-insensitive file
// system two names that differ only in case are one path. When two versions
// want the same name, one as a file and one as a folder, the folder wins and
// the file's content is saved beside it as a conflict copy; for two files
// that differ only in case, the one with the lower file id keeps the path,
// the other is saved as a copy.
//
// Every device must end up with the same copy name, or each would push a
// copy of its own. So the name comes from the file's version (its device
// name and mtime, in UTC), not from this device's clock or time zone.
import { decryptMeta, type FileMeta } from '../crypto/objects';
import { fromHex, toHex } from '../util/bytes';
import { conflictCopyName, UNKNOWN_DEVICE } from '../util/path';
import type { FileRecord } from '../state/store';
import { expectFor, type FileStat } from '../vault/adapter';
import { hashHex } from './content';
import type { SyncContext } from './context';
import { isCycleError } from './failures';
import { isSyncedHere } from './local';

export interface Stamp {
  device: string;
  mtimeMs: number;
}

/** The device a version's metadata names, for a conflict copy's name. */
export function deviceLabel(meta: Pick<FileMeta, 'deviceName'>): string {
  return meta.deviceName || UNKNOWN_DEVICE;
}

/**
 * The first conflict-copy name for path (numbered 1, 2, …) that no file or
 * folder here holds and no record knows. utc: a name every device must
 * derive alike (collisions); otherwise local time (a conflict while
 * applying). With reuseContentHash, a file already there with that content
 * is reused (exists: true): another device saved the same copy first and it
 * synced. A tombstone record blocks a name only for local-time names, so
 * devices with different histories still derive the same UTC names.
 */
export async function freeCopyPath(
  ctx: SyncContext, path: string, stamp: Stamp, opts: { utc: boolean; reuseContentHash?: string },
): Promise<{ path: string; exists: boolean }> {
  for (let n = 1; ; n++) {
    const candidate = conflictCopyName(path, stamp.device, stamp.mtimeMs, n, opts.utc);
    const st = await ctx.adapter.stat(candidate);
    if (st) {
      if (opts.reuseContentHash !== undefined) {
        const data = await ctx.adapter.read(candidate);
        if (data && (await hashHex(data)) === opts.reuseContentHash) return { path: st.path, exists: true };
      }
      continue;
    }
    if (await ctx.adapter.hasFolder(candidate)) continue;
    if ((await ctx.state.filesByPath(candidate)).some((r) => !opts.utc || !r.deleted)) continue;
    return { path: candidate, exists: false };
  }
}

/**
 * Saves an incoming file that cannot take its path here (a local folder, or
 * a file whose name differs only in letter case holds it) as a conflict
 * copy; returns the copy's path, or null if the target changed meanwhile.
 */
export async function saveBeside(ctx: SyncContext, meta: FileMeta, contentHash: string, data: Uint8Array): Promise<string | null> {
  const target = await freeCopyPath(ctx, meta.path, { device: deviceLabel(meta), mtimeMs: meta.mtimeMs }, { utc: true, reuseContentHash: contentHash });
  if (!target.exists && !(await ctx.adapter.write(target.path, data, { absent: true }))) return null;
  await ctx.state.markDirty(target.path);
  return target.path;
}

/** The device and mtime inside a synced version's metadata, or null when the server no longer has it or it cannot be read. */
async function stampOf(ctx: SyncContext, rec: FileRecord): Promise<Stamp | null> {
  const versions = await ctx.api.history(ctx.ring.vaultId, fromHex(rec.fileId));
  const v = versions.find((x) => toHex(x.versionId) === rec.versionId);
  if (!v) return null;
  try {
    const meta = await decryptMeta(ctx.ring, v.epoch, v.fileId, v.versionId, v.encMeta);
    return { device: deviceLabel(meta), mtimeMs: meta.mtimeMs };
  } catch (err) {
    if (isCycleError(err)) throw err;
    return null;
  }
}

/**
 * Moves the local file st to a conflict copy (a rename, so its content is
 * not uploaded again), because another file takes its name. A file that is
 * unchanged since it was synced is named after its version; one that was
 * edited or never synced is named after this device and the file's mtime,
 * since no other device has that content. Returns false when the file
 * changed while it was being moved.
 */
export async function moveToCopy(ctx: SyncContext, st: FileStat, code: 'PATH_COLLISION' | 'CASE_COLLISION', why: string): Promise<boolean> {
  const data = await ctx.adapter.read(st.path);
  if (!data) return false;
  const hash = await hashHex(data);
  const rec = (await ctx.state.filesByPath(st.path)).find(isSyncedHere);
  const unchanged = !!rec && !rec.deleted && rec.contentHash === hash;
  const stamp = (unchanged ? await stampOf(ctx, rec) : null) ?? { device: ctx.deviceName, mtimeMs: st.mtime };
  const target = await freeCopyPath(ctx, st.path, stamp, { utc: true, reuseContentHash: hash });
  const moved = target.exists
    ? await ctx.adapter.remove(st.path, expectFor(st))
    : await ctx.adapter.rename(st.path, target.path, expectFor(st));
  if (!moved) return false;
  await ctx.state.markDirty(st.path);
  await ctx.state.markDirty(target.path, target.exists ? undefined : st.path);
  ctx.emit({ type: 'notice', code, persistent: false, path: st.path, conflictPath: target.path, message: `${st.path} ${why}; it was moved to ${target.path}` });
  return true;
}

/**
 * Before path is written: a local file stands where one of path's parent
 * folders must be. The folder wins, so the file moves to a conflict copy.
 * Returns false when the file changed while it was being moved.
 */
export async function evictBlockingFile(ctx: SyncContext, path: string): Promise<boolean> {
  const parts = path.split('/');
  for (let i = 1; i < parts.length; i++) {
    const st = await ctx.adapter.stat(parts.slice(0, i).join('/'));
    if (st && !(await moveToCopy(ctx, st, 'PATH_COLLISION', 'is a folder on another device'))) return false;
  }
  return true;
}
