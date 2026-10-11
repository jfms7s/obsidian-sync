// Two clients on one folder take turns (headless client spec, D4): while
// the plugin's engine runs, it rewrites a small file in its own data folder
// (inside the config folder, never synced) every HEARTBEAT_INTERVAL_MS, and
// obsync-cli, on the same folder, pauses while that file is younger than
// HEARTBEAT_STALE_MS. Otherwise each would take the other's writes for
// local edits and push them again.
import type { Clock, TimerHandle } from '../util/clock';

/** The file's name, in the plugin's folder (<configDir>/plugins/<id>/). */
export const HEARTBEAT_FILE = 'active';
export const HEARTBEAT_INTERVAL_MS = 30_000;
/** A heartbeat older than this means the plugin stopped (or Obsidian was closed or killed). */
export const HEARTBEAT_STALE_MS = 90_000;

export interface Heartbeat {
  obsync: 1;
  /** When it was written (ms). */
  at: number;
  /** The plugin's device name, for the CLI's log. */
  device: string;
}

/** Where the heartbeat goes; the plugin writes through Obsidian's DataAdapter. */
export interface HeartbeatSink {
  write(text: string): Promise<void>;
  remove(): Promise<void>;
}

export function parseHeartbeat(text: string): Heartbeat | null {
  try {
    const v = JSON.parse(text) as Partial<Heartbeat> | null;
    return v?.obsync === 1 && typeof v.at === 'number' && Number.isFinite(v.at) ? { obsync: 1, at: v.at, device: typeof v.device === 'string' ? v.device : '' } : null;
  } catch {
    return null;
  }
}

/**
 * Whether a heartbeat written at `at` still means the plugin is syncing. One
 * a little in the future (a clock set back) counts; one further ahead than
 * HEARTBEAT_STALE_MS (a skewed clock, a copied folder) does not, so it cannot
 * hold obsync-cli off for long.
 */
export function isFresh(hb: Heartbeat, now: number): boolean {
  return now - hb.at < HEARTBEAT_STALE_MS && hb.at - now < HEARTBEAT_STALE_MS;
}

/** How long stopping waits for a heartbeat write in flight before removing the file anyway. */
export const HEARTBEAT_STOP_WAIT_MS = 2000;

/**
 * Writes the heartbeat now and every interval until the returned stop is
 * called, which removes the file so the CLI can resume at once. A failed
 * write is retried at the next beat (the CLI then resumes after
 * HEARTBEAT_STALE_MS, which is the safe direction).
 */
export function startHeartbeat(sink: HeartbeatSink, clock: Clock, device: string): () => Promise<void> {
  let timer: TimerHandle | null = null;
  let stopped = false;
  let writing: Promise<void> = Promise.resolve();
  const beat = () => {
    if (stopped) return;
    const hb: Heartbeat = { obsync: 1, at: clock.now(), device };
    writing = writing.then(() => (stopped ? undefined : sink.write(JSON.stringify(hb)))).catch(() => undefined);
    timer = clock.setTimeout(beat, HEARTBEAT_INTERVAL_MS);
  };
  beat();
  return async () => {
    stopped = true;
    if (timer) clock.clearTimeout(timer);
    // A write that never settles must not hold up the engine's stop (and its lock).
    let wait: TimerHandle | null = null;
    await Promise.race([writing, new Promise<void>((r) => (wait = clock.setTimeout(r, HEARTBEAT_STOP_WAIT_MS)))]);
    if (wait) clock.clearTimeout(wait);
    await sink.remove().catch(() => undefined);
  };
}
