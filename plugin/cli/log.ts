// obsync-cli writes its log to stderr, one line per entry; under systemd the
// journal keeps it (journalctl --user -u obsync-cli).
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
