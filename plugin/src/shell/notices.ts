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
      return shown(e.conflictPath ? movedTo(e.path, e.conflictPath) : `${file(e.path)} is not synced from this device: the server has a file that differs from it only in letter case.`);
    case 'PATH_COLLISION':
      return shown(e.conflictPath ? movedTo(e.path, e.conflictPath) : `${file(e.path)} is not synced from this device: the server's file of this name was saved beside a folder that held the name here.`);
    case 'TOO_LARGE':
      return shown(tooLarge(e.path, e.reason, e.size, e.limit, e.conflictPath));
    case 'DECRYPT_FAILED':
      return shown(`a version of ${file(e.path)} from the server could not be decrypted, so it was skipped. It is tried again later.`);
    case 'SERVER_ROLLBACK':
      return shown('the server was restored from a backup. Every file is being compared with it again.');
    case 'COMMIT_REJECTED':
      return shown(`the server refused ${file(e.path)}${e.reason ? ` (${e.reason})` : ''}; it is not synced until it changes.`);
    case 'INVALID_PATH':
      return shown(`${file(e.path)} cannot be synced${e.reason ? ` (${e.reason})` : ''}: rename it to sync it.`);
    case 'CONTENT_MISSING':
      return shown(`the server is missing part of ${file(e.path)}, so that version was skipped.`);
    case 'DELETIONS_HELD':
      return shown(`${e.count ?? 'some'} files deleted on this device are on hold: they stay on your other devices until you choose, in the Obsync settings, to delete them everywhere or restore them here.`);
    case 'IGNORE_LINES_SKIPPED':
      return shown(`${e.count ?? 'some'} ${e.count === 1 ? 'line' : 'lines'} of ${file(e.path)} use unsupported syntax and were skipped. See the Obsync settings.`);
    case 'FILE_FAILED':
      return shown(`${file(e.path)} could not be synced just now. It is tried again later; the rest keeps syncing.`);
    default: {
      const unhandled: never = e.code;
      return shown(`something needs attention (${String(unhandled)}).`);
    }
  }
}

const file = (path: string | undefined): string => path ?? 'a file';

function movedTo(path: string | undefined, copy: string): string {
  return `${file(path)} could not keep its name here, so it was saved as ${copy}.`;
}

const mib = (bytes: number): string => `${Math.round(bytes / (1 << 20))} MiB`;

function tooLarge(path: string | undefined, reason: string | undefined, size: number | undefined, limit: number | undefined, copy: string | undefined): string {
  const sizes = size !== undefined && limit !== undefined ? [` (${mib(size)})`, ` (${mib(limit)})`] : ['', ''];
  switch (reason) {
    case 'download':
      return `${file(path)}${sizes[0]} is larger than this device syncs${sizes[1]} and was not downloaded.${copy ? ` Your local changes were saved as ${copy}.` : ''}`;
    case 'upload':
      return `${file(path)}${sizes[0]} is larger than this device syncs${sizes[1]} and was not uploaded.`;
    case 'remote':
      return `${file(path)} is not synced from this device: the server's version is larger than this device syncs.`;
    default:
      return `${file(path)} is larger than the server accepts and was not synced.`;
  }
}
