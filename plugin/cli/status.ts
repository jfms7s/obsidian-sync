// What the sync daemon is doing, for `obsync-cli status` in another
// process: <state-dir>/status.json, rewritten whenever it changes.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SyncStatus } from '../src/index';
import { writeFileAtomic } from './state';

export const STATUS_FILE = 'status.json';

export interface RecentNotice {
  at: number;
  code: string;
  message: string;
  path?: string;
}

export interface DaemonStatus {
  pid: number;
  vaultDir: string;
  status: SyncStatus;
  detail?: string;
  /** When status last changed (ms). */
  since: number;
  /** When the daemon was last 'synced' (ms), or null. */
  lastSynced: number | null;
  /** Set while the daemon holds off for another client on the folder (Obsidian's plugin). */
  paused: { reason: string; since: number } | null;
  /** The newest notices, oldest first. */
  notices: RecentNotice[];
}

export const MAX_NOTICES = 20;

export async function writeStatus(dir: string, s: DaemonStatus): Promise<void> {
  await writeFileAtomic(join(dir, STATUS_FILE), JSON.stringify(s, null, 2));
}

export async function readStatus(dir: string): Promise<DaemonStatus | null> {
  try {
    return JSON.parse(await readFile(join(dir, STATUS_FILE), 'utf8')) as DaemonStatus;
  } catch {
    return null;
  }
}
