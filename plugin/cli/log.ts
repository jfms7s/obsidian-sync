// obsync-cli writes its log to stderr, one line per entry; under systemd the
// journal keeps it (journalctl --user -u obsync-cli).
import { ApiError, errorCodeName } from '../src/index';

export type Level = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export function streamLogger(write: (line: string) => void, verbose: boolean): Logger {
  const at = (level: Level) => (message: string) => {
    if (level === 'debug' && !verbose) return;
    write(`${new Date().toISOString()} ${level}: ${message}\n`);
  };
  return { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') };
}

/**
 * What kind of error this is, for a log that must name no path: its name,
 * and its code ('Error ENOENT', 'ApiError QUOTA_EXCEEDED'). Never its message
 * or stack, which may name a file.
 */
export function errorKind(err: unknown): string {
  if (!(err instanceof Error)) return 'unknown error';
  const code: unknown = err instanceof ApiError ? errorCodeName(err.code) : (err as { code?: unknown }).code;
  return typeof code === 'string' ? `${err.name} ${code}` : err.name;
}
