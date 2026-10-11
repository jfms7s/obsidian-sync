// Exit codes (spec): systemd shows a failed unit for 1 and 2, and the unit
// does not restart on 2, which waits for a person to log in or unlock.
export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
/** Needs login, unlock or a vault choice (or the device was revoked or lost the vault). */
export const EXIT_NEEDS_SETUP = 2;

/** An expected failure: its message is shown as it is, with this exit code. */
export class CliError extends Error {
  constructor(message: string, readonly exitCode: number = EXIT_ERROR) {
    super(message);
    this.name = 'CliError';
  }
}
