// "Also remove these files from the server": when new ignore rules match
// files this device already synced, the user may ask to delete them on the
// server too, while this device keeps its copies. The paths are stored as
// approved removals; push then commits a deletion for each one that the
// rules still ignore, as if it had been deleted here. Other devices that do
// not ignore them move their copies to the trash; the server keeps the
// content in its deleted files for the trash period.
import type { LocalState } from '../state/store';
import type { IgnoreRules } from '../vault/ignore';

const SETTING = 'serverRemovals';

export interface NewlyIgnored {
  /** Synced files the new rules match and the old ones did not, in path order. */
  paths: string[];
  /** Their size as last synced, in bytes. */
  bytes: number;
}

/**
 * The files that changing the rules from before to after newly ignores,
 * from the local records (no network): synced, live on the server as far
 * as this device knows, matched by after and not by before.
 */
export async function newlyIgnored(state: LocalState, before: IgnoreRules, after: IgnoreRules): Promise<NewlyIgnored> {
  const paths: string[] = [];
  let bytes = 0;
  for (const r of await state.allFiles()) {
    if (r.versionId === null || r.deleted || before.matches(r.path) || !after.matches(r.path)) continue;
    paths.push(r.path);
    bytes += r.size;
  }
  paths.sort();
  return { paths, bytes };
}

/** The removals the user approved that are not pushed yet. */
export async function serverRemovals(state: LocalState): Promise<Set<string>> {
  return new Set(await state.getSetting<string[]>(SETTING, []));
}

/** Approves the removal of paths from the server and queues them for push. */
export async function approveServerRemoval(state: LocalState, paths: readonly string[]): Promise<void> {
  const all = await serverRemovals(state);
  for (const p of paths) all.add(p);
  await state.setSetting(SETTING, [...all].sort());
  for (const p of paths) await state.markDirty(p);
}

/** Drops paths from the approved removals (pushed, or no longer ignored: a later rule change needs a new answer). */
export async function forgetServerRemovals(state: LocalState, paths: Iterable<string>): Promise<void> {
  const all = await serverRemovals(state);
  let changed = false;
  for (const p of paths) changed = all.delete(p) || changed;
  if (changed) await state.setSetting(SETTING, [...all].sort());
}
