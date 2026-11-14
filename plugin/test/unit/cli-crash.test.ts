import { describe, expect, it } from 'vitest';
import { crashLine, installCrashHandlers } from '../../cli/crash';

function leaky(): Error {
  const err = Object.assign(new Error("ENOENT: no such file or directory, open '/vault/mimir/Secret Title.md'"), { code: 'ENOENT' });
  err.stack = `Error: ${err.message}\n    at /vault/mimir/Secret Title.md:1:1`;
  return err;
}

describe('obsync-cli crash handlers', () => {
  it('print only the error kind, never its message or stack', () => {
    expect(crashLine(leaky())).toBe('obsync-cli: crashed: Error ENOENT\n');
    expect(crashLine('mimir/Secret Title.md')).toBe('obsync-cli: crashed: unknown error\n');
  });

  it('are installed for uncaught exceptions and unhandled rejections, and exit 1', () => {
    const handlers = new Map<string, (err: unknown) => void>();
    let out = '';
    const codes: number[] = [];
    installCrashHandlers((t) => (out += t), (c) => codes.push(c), { on: ((event: string, fn: (err: unknown) => void) => (handlers.set(event, fn), process)) as NodeJS.Process['on'] });
    expect([...handlers.keys()].sort()).toEqual(['uncaughtException', 'unhandledRejection']);
    handlers.get('unhandledRejection')!(leaky());
    handlers.get('uncaughtException')!(leaky());
    expect(out).toBe('obsync-cli: crashed: Error ENOENT\nobsync-cli: crashed: Error ENOENT\n');
    expect(out).not.toMatch(/Secret|mimir|vault/);
    expect(codes).toEqual([1, 1]);
  });
});
