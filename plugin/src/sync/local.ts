// What this device holds locally for a file, shared by apply, collisions and push.
import type { FileRecord } from '../state/store';
import type { FileStat } from '../vault/adapter';
import type { SyncContext } from './context';

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
