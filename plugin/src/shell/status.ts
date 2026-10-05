import type { SyncStatus } from '../sync/events';

const LABELS: Record<SyncStatus, string> = {
  synced: 'Synced',
  syncing: 'Syncing',
  offline: 'Offline',
  error: 'Sync error',
  stopped: 'Sync stopped',
};

/** The short text of the status bar item. */
export function statusLabel(status: SyncStatus): string {
  return LABELS[status];
}
