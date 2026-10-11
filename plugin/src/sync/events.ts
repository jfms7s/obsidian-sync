// What the engine tells the UI (plan 3: status bar and notices).

export type SyncStatus = 'synced' | 'syncing' | 'offline' | 'error' | 'stopped';

export type NoticeCode =
  | 'QUOTA_EXCEEDED' // persistent: free space or ask the admin
  | 'DEVICE_REVOKED' // persistent: log in again
  | 'UNAUTHORIZED' // persistent: log in again
  | 'TOO_LARGE' // persistent: the file is not synced
  | 'VAULT_LOST' // persistent: the vault was deleted or access was removed
  | 'CASE_COLLISION' // a remote file differs only in case from a local one
  | 'PATH_COLLISION' // a file and a folder want the same path; the folder wins and the file is saved as a conflict copy
  | 'DECRYPT_FAILED' // a version from the server did not authenticate
  | 'SERVER_ROLLBACK' // the server lost history (restored from a backup); everything is re-checked
  | 'COMMIT_REJECTED' // the server refused a commit as invalid
  | 'INVALID_PATH' // a local path cannot be synced
  | 'CONTENT_MISSING' // the server lost a chunk of a version; it is skipped
  | 'DELETIONS_HELD' // persistent: a large local deletion waits for the user's answer before it reaches other devices
  | 'IGNORE_LINES_SKIPPED' // some lines of the vault's .obsyncignore use unsupported syntax; the rest applies
  | 'FILE_FAILED'; // one file failed (for example a local I/O error); retried later, the rest keeps syncing

export type EngineEvent =
  | { type: 'status'; status: SyncStatus; detail?: string }
  | {
    type: 'notice';
    code: NoticeCode;
    /** For logs; the shell words what people see from the fields below (shell/notices.ts). */
    message: string;
    persistent: boolean;
    path?: string;
    /** The file that was saved beside it, for collisions (and a local copy kept when a too large version arrives). */
    conflictPath?: string;
    /**
     * A short, fixed reason: for TOO_LARGE 'download' | 'upload' | 'remote' | 'server'; for INVALID_PATH
     * why the name is refused; for COMMIT_REJECTED the server's explanation; for a per-file failure the error's class.
     */
    reason?: string;
    /** For TOO_LARGE: the file's size and this device's limit, in bytes. */
    size?: number;
    limit?: number;
    /** For DELETIONS_HELD: how many deleted files are on hold; for IGNORE_LINES_SKIPPED, how many lines were skipped. */
    count?: number;
  }
  | { type: 'conflict'; path: string; conflictPath: string }
  | { type: 'merged'; path: string }
  | { type: 'remote-change'; path: string; action: 'write' | 'delete' };

export type EngineListener = (e: EngineEvent) => void;
