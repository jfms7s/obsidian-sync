// Obsidian's settings files from other devices (the settings layer, spec
// 2026-10-11-settings-layer-design D4 and D6). Obsidian keeps its settings
// in memory and rewrites a whole file whenever the user changes any one
// setting, so after a remote version is written here and before Obsidian
// restarts, its next write would put this device's stale copy back plus the
// one change, and push it everywhere. The text a file had before the first
// remote write since the plugin loaded is kept (SyncContext.restartBases)
// and serves as the merge base for this device's own writes until then, so
// only the keys really changed here are pushed.
import { mergeJsonSettings } from '../merge/json-merge';
import { utf8 } from '../util/bytes';
import { expectFor } from '../vault/adapter';
import { decodeText, hashHex } from './content';
import type { SyncContext } from './context';
import { readLocal, type LocalFile } from './local';

/** A settings file the engine wrote since the plugin loaded. */
export interface RestartBase {
  /** The text before the first such write (no file: an empty object): what Obsidian holds in memory. */
  before: string;
  /** The content hash the engine wrote last: the file still holding it is the engine's own write, not Obsidian's. */
  written: string | null;
}

/** Before the engine overwrites a settings file: keeps what Obsidian may still hold (only the first time since the plugin loaded). */
export function rememberBeforeWrite(ctx: SyncContext, path: string, before: string | null): void {
  if (ctx.restartBases && !ctx.restartBases.has(path)) ctx.restartBases.set(path, { before: before ?? '{}', written: null });
}

/** After the engine wrote a settings file: what it wrote. */
export function rememberWritten(ctx: SyncContext, path: string, contentHash: string): void {
  const b = ctx.restartBases?.get(path);
  if (b) b.written = contentHash;
}

/**
 * Before pushing a local change to a settings file that a remote version
 * overwrote since the plugin loaded: merges the change into the synced
 * version with the text from before that write as the base, writes the
 * result, and returns the file as it is now (null when it changed
 * meanwhile: try again later). Unchanged when nothing needs merging or a
 * side is not a JSON object.
 */
export async function mergeStaleWrite(ctx: SyncContext, path: string, fileId: string, recordHash: string | null, local: LocalFile): Promise<LocalFile | null> {
  const base = ctx.restartBases?.get(path);
  if (base === undefined || !ctx.ignore.isSettingsFile(path)) return local;
  const localHash = await hashHex(local.data);
  if (localHash === recordHash || localHash === base.written) return local;
  const synced = await ctx.state.getBase(fileId);
  const localText = decodeText(path, local.data);
  if (synced == null || localText === null) return local;
  const merged = mergeJsonSettings(base.before, localText, synced);
  if (merged === null || merged === localText) return local;
  const data = utf8(merged);
  if (!(await ctx.adapter.write(path, data, expectFor(local.stat)))) return null;
  rememberWritten(ctx, path, await hashHex(data));
  return readLocal(ctx, path);
}
