// A large local deletion is held on this device until the user answers
// (owner decision 2026-10-09). A wiped or unmounted folder, `git clean`, a
// wrong checkout or a script bug would otherwise delete the files on every
// device. The hold is stored, so it survives a reload, and reconcile does
// not queue held files again.
import type { DeletionHold, DirtyEntry, LocalState } from '../state/store';
import { normalizePath } from '../util/path';
import { isSyncedHere } from './apply';
import type { SyncContext } from './context';

/** A deletion is held when it removes more than this many files… */
export const HOLD_MIN_FILES = 50;
/** …and more than this share of the synced files. */
export const HOLD_MIN_SHARE = 0.2;

/** Engine-lifetime memory: how many held files the user was last told about. */
export interface HoldMemory {
  heldNotified: number;
}

const EMPTY: DeletionHold = { held: [], approved: [] };

async function load(state: LocalState): Promise<DeletionHold> {
  return (await state.getDeletionHold()) ?? EMPTY;
}

/** The paths of the local deletions on hold. */
export async function heldDeletions(state: LocalState): Promise<string[]> {
  return [...(await load(state)).held];
}

/** "Delete on all devices": the held deletions are pushed as usual. Returns how many. */
export async function releaseHeldDeletions(state: LocalState): Promise<number> {
  const h = await load(state);
  if (h.held.length === 0) return 0;
  // Approved before they are queued again, so a push round in between cannot hold them a second time.
  await state.setDeletionHold({ held: [], approved: [...new Set([...h.approved, ...h.held])] });
  for (const path of h.held) await state.markDirty(path);
  return h.held.length;
}

/**
 * "Restore here": the held files are written again from the server. Their
 * records forget the synced version, so the next reconcile applies the
 * server's head (ask the engine for one). Returns how many.
 */
export async function restoreHeldDeletions(state: LocalState): Promise<number> {
  const h = await load(state);
  if (h.held.length === 0) return 0;
  for (const path of h.held) {
    for (const rec of await state.filesByPath(path)) {
      if (isSyncedHere(rec) && !rec.deleted) await state.putFile({ ...rec, versionId: null, contentHash: null, hasBase: false, localMtime: -1, seq: 0 });
    }
  }
  await state.setDeletionHold({ held: [], approved: h.approved });
  return h.held.length;
}

/** Drops held paths that are files again here (restored by the user outside Obsidian). */
export async function forgetHeldPresent(state: LocalState, present: (path: string) => boolean): Promise<void> {
  const h = await load(state);
  const held = h.held.filter((p) => !present(p));
  if (held.length !== h.held.length) await state.setDeletionHold({ ...h, held });
}

function normalized(path: string): string | null {
  try {
    return normalizePath(path);
  } catch {
    return null;
  }
}

/**
 * Called by push with the whole dirty set before a round. Puts on hold the
 * deletions of synced files when they are more than HOLD_MIN_FILES and more
 * than HOLD_MIN_SHARE of the synced files, or when a hold is already
 * waiting (further deletions wait with it). Held entries leave the dirty
 * set; returns the entries to push. The old path of a rename is not a
 * deletion, and approved deletions ("Delete on all devices") pass.
 */
export async function holdLargeDeletions(ctx: SyncContext, mem: HoldMemory, entries: DirtyEntry[]): Promise<DirtyEntry[]> {
  const { state } = ctx;
  const stored = await load(state);
  // Too few entries to reach the threshold, and nothing held: no need to look at the records.
  if (stored.held.length === 0 && entries.length <= HOLD_MIN_FILES) return entries;

  const synced = new Map<string, true>();
  for (const r of await state.allFiles()) if (isSyncedHere(r) && !r.deleted) synced.set(r.path, true);
  const held = new Set(stored.held);
  // An approved deletion stays approved until it is pushed (its record is a tombstone then).
  const approved = new Set(stored.approved.filter((p) => synced.has(p)));
  const renamedAway = new Set(entries.flatMap((e) => (e.renamedFrom !== undefined ? [e.renamedFrom] : [])));
  const candidates: Array<{ entry: DirtyEntry; path: string }> = [];
  const rest: DirtyEntry[] = [];
  for (const entry of entries) {
    const path = normalized(entry.path);
    if (path === null || approved.has(path) || renamedAway.has(entry.path) || !synced.has(path) || (await ctx.adapter.stat(path))) {
      if (path !== null) held.delete(path); // a held file that is back here syncs as usual
      rest.push(entry);
      continue;
    }
    candidates.push({ entry, path });
  }
  const hold = candidates.length > 0 && (held.size > 0 || (candidates.length > HOLD_MIN_FILES && candidates.length > HOLD_MIN_SHARE * synced.size));
  if (hold) {
    for (const c of candidates) {
      held.add(c.path);
      await state.clearDirty(c.entry.path, c.entry.gen);
    }
  } else {
    rest.push(...candidates.map((c) => c.entry));
  }
  const next: DeletionHold = { held: [...held].sort(), approved: [...approved].sort() };
  if (next.held.join('\0') !== [...stored.held].sort().join('\0') || next.approved.join('\0') !== [...stored.approved].sort().join('\0')) {
    await state.setDeletionHold(next);
  }
  if (next.held.length > 0 && next.held.length !== mem.heldNotified) {
    mem.heldNotified = next.held.length;
    ctx.emit({
      type: 'notice', code: 'DELETIONS_HELD', persistent: true,
      message: `${next.held.length} files deleted on this device are on hold: they stay on your other devices until you choose, in the Obsync settings, to delete them everywhere or restore them here.`,
    });
  }
  return rest;
}
