// Secrets (account password, encryption passphrase, recovery words) come
// from the terminal with echo off, or from a file descriptor the caller
// opened (--password-fd 3 3<file); never from an argument, which every
// user on the machine can read in the process list.
import { readFileSync } from 'node:fs';

export class NoTerminalError extends Error {
  constructor(what: string, flag: string) {
    super(`${what} must be typed at a terminal, or given on a file descriptor with ${flag} N`);
    this.name = 'NoTerminalError';
  }
}

/** The first line of what can be read from fd (up to its end), without the line break. */
export function readSecretFd(fd: number): string {
  const text = readFileSync(fd, 'utf8');
  const line = text.split(/\r?\n/)[0] ?? '';
  if (line === '') throw new Error(`file descriptor ${fd} gave an empty line`);
  return line;
}

/** Asks on the terminal with echo off. Ctrl-C exits (130), Ctrl-D cancels. */
export function promptHidden(question: string, what: string, flag: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY || !process.stderr.isTTY) return Promise.reject(new NoTerminalError(what, flag));
  process.stderr.write(question);
  return new Promise((resolve, reject) => {
    let value = '';
    /** Inside a terminal escape sequence (an arrow or function key): not part of the secret. */
    let escape: 'no' | 'esc' | 'csi' = 'no';
    const done = (err: Error | null) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off('data', onData);
      process.stderr.write('\n');
      if (err) reject(err);
      else resolve(value);
    };
    const onData = (chunk: Buffer) => {
      for (const ch of chunk.toString('utf8')) {
        if (escape === 'esc') {
          escape = ch === '[' || ch === 'O' ? 'csi' : 'no';
          continue;
        }
        if (escape === 'csi') {
          if (ch >= '@' && ch <= '~') escape = 'no'; // the sequence's final byte
          continue;
        }
        if (ch === '\u001b') {
          escape = 'esc';
        } else if (ch === '\u0003') {
          stdin.setRawMode(false);
          process.stderr.write('\n');
          process.exit(130);
        } else if (ch === '\u0004') {
          done(new Error('cancelled'));
          return;
        } else if (ch === '\r' || ch === '\n') {
          done(null);
          return;
        } else if (ch === '\u007f' || ch === '\b') {
          value = [...value].slice(0, -1).join('');
        } else if (ch >= ' ') {
          value += ch;
        }
      }
    };
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onData);
  });
}

/** A secret from fd when given, else from the terminal. */
export async function secret(fd: number | undefined, question: string, what: string, flag: string): Promise<string> {
  return fd === undefined ? promptHidden(question, what, flag) : readSecretFd(fd);
}
