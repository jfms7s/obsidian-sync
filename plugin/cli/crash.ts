// The last resort for an error nothing caught. Its message and stack may name a
// note, so only its kind is written (the same rule as a --only sync's log).
import { errorKind } from './log';

export function crashLine(err: unknown): string {
  return `obsync-cli: crashed: ${errorKind(err)}\n`;
}

/** Makes an uncaught exception or unhandled rejection print its kind and exit 1. */
export function installCrashHandlers(write: (text: string) => void, exit: (code: number) => void, on: Pick<NodeJS.Process, 'on'> = process): void {
  const crash = (err: unknown) => {
    write(crashLine(err));
    exit(1);
  };
  on.on('unhandledRejection', crash);
  on.on('uncaughtException', crash);
}
