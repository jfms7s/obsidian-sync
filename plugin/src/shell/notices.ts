// What the user is told about engine events (the engine's messages are for logs; these are for people).
import type { EngineEvent } from '../sync/events';

export interface NoticeView {
  message: string;
  /** Milliseconds on screen; 0 keeps it until the user closes it. */
  timeoutMs: number;
}

const TIMEOUT_MS = 8000;

/** The notice to show for an event, or null for events that need none. */
export function noticeFor(e: EngineEvent): NoticeView | null {
  if (e.type === 'conflict') {
    return { message: `Obsync: conflicting changes in ${e.path}. Your version was kept and the other one saved as ${e.conflictPath}`, timeoutMs: TIMEOUT_MS * 2 };
  }
  if (e.type !== 'notice') return null;
  const shown = (message: string): NoticeView => ({ message: `Obsync: ${message}`, timeoutMs: e.persistent ? 0 : TIMEOUT_MS });
  switch (e.code) {
    case 'QUOTA_EXCEEDED':
      return shown('the storage quota is used up. Changes stay on this device until space is freed.');
    case 'DEVICE_REVOKED':
    case 'UNAUTHORIZED':
      return shown('this device was signed out. Sign in again in the plugin settings to keep syncing.');
    case 'VAULT_LOST':
      return shown('the vault was deleted or you no longer have access to it. Syncing has stopped.');
    case 'CASE_COLLISION':
    case 'PATH_COLLISION':
      return shown(e.conflictPath ? `${e.path ?? 'a file'} could not keep its name here, so it was saved as ${e.conflictPath}.` : e.message);
    default:
      return shown(e.message);
  }
}
