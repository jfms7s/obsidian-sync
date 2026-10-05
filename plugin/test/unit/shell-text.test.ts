import { describe, expect, it } from 'vitest';
import { ApiError, ErrorCode, NetworkError } from '../../src/api/errors';
import { InsecureServerUrlError } from '../../src/api/url';
import { CryptoError } from '../../src/crypto/primitives';
import { Argon2TooCostlyError, InvalidRecoveryWordsError } from '../../src/crypto/userkeys';
import { MissingEpochKeyError } from '../../src/crypto/vaultkeys';
import { NotInTrashError, PathOccupiedError, UnsyncedChangesError } from '../../src/services/history';
import { diffLines, MAX_DIFF_LINES } from '../../src/shell/diff';
import { describeError } from '../../src/shell/errors';
import { noticeFor } from '../../src/shell/notices';
import { statusLabel } from '../../src/shell/status';

describe('diffLines', () => {
  it('marks added, removed and unchanged lines', () => {
    expect(diffLines('a\nb\nc\n', 'a\nB\nc\nd\n')).toEqual([
      { kind: 'same', text: 'a' }, { kind: 'del', text: 'b' }, { kind: 'add', text: 'B' }, { kind: 'same', text: 'c' }, { kind: 'add', text: 'd' },
    ]);
  });

  it('treats identical text, empty text and line endings sensibly', () => {
    expect(diffLines('x\n', 'x\n')).toEqual([{ kind: 'same', text: 'x' }]);
    expect(diffLines('', 'new\n')).toEqual([{ kind: 'add', text: 'new' }]);
    expect(diffLines('old', '')).toEqual([{ kind: 'del', text: 'old' }]);
    expect(diffLines('a\r\nb\r\n', 'a\nb\n')).toEqual([{ kind: 'same', text: 'a' }, { kind: 'same', text: 'b' }]);
    expect(diffLines('', '')).toEqual([]);
  });

  it('gives up on files with too many lines instead of freezing the app', () => {
    const big = 'line\n'.repeat(MAX_DIFF_LINES + 1);
    expect(diffLines(big, 'x\n')).toBeNull();
    expect(diffLines('x\n', big)).toBeNull();
  });
});

describe('statusLabel', () => {
  it('has a short sentence-case label for every status', () => {
    expect(['synced', 'syncing', 'offline', 'error', 'stopped'].map((s) => statusLabel(s as never))).toEqual(['Synced', 'Syncing', 'Offline', 'Sync error', 'Sync stopped']);
  });
});

describe('noticeFor', () => {
  it('keeps persistent notices until dismissed and times the others out', () => {
    expect(noticeFor({ type: 'notice', code: 'QUOTA_EXCEEDED', persistent: true, message: 'x' })).toMatchObject({ timeoutMs: 0, message: expect.stringContaining('storage quota') });
    expect(noticeFor({ type: 'notice', code: 'FILE_FAILED', persistent: false, path: 'a.md', message: 'a.md: disk error' })).toEqual({ message: 'Obsync: a.md: disk error', timeoutMs: 8000 });
  });

  it('says what to do when the device is signed out or loses the vault', () => {
    expect(noticeFor({ type: 'notice', code: 'DEVICE_REVOKED', persistent: true, message: 'x' })!.message).toMatch(/sign in again/i);
    expect(noticeFor({ type: 'notice', code: 'UNAUTHORIZED', persistent: true, message: 'x' })!.message).toMatch(/sign in again/i);
    expect(noticeFor({ type: 'notice', code: 'VAULT_LOST', persistent: true, message: 'x' })!.message).toMatch(/vault/i);
  });

  it('names the copy when two files collide or conflict', () => {
    const collision = noticeFor({ type: 'notice', code: 'PATH_COLLISION', persistent: false, path: 'docs', conflictPath: 'docs (conflict A 2026-01-01 0000)', message: 'x' })!;
    expect(collision.message).toContain('docs (conflict A 2026-01-01 0000)');
    const conflict = noticeFor({ type: 'conflict', path: 'a.md', conflictPath: 'a (conflict B 2026-01-01 0000).md' })!;
    expect(conflict.message).toContain('a.md');
    expect(conflict.message).toContain('a (conflict B 2026-01-01 0000).md');
  });

  it('stays quiet about status changes, merges and remote changes', () => {
    expect(noticeFor({ type: 'status', status: 'synced' })).toBeNull();
    expect(noticeFor({ type: 'merged', path: 'a.md' })).toBeNull();
    expect(noticeFor({ type: 'remote-change', path: 'a.md', action: 'write' })).toBeNull();
  });
});

describe('describeError', () => {
  const err = (code: ErrorCode, message = 'm', status = 400, retryAfterMs?: number) => new ApiError(code, message, status, retryAfterMs);

  it('explains an unreachable server and an insecure address', () => {
    expect(describeError(new NetworkError('POST /x: fetch failed'))).toMatchObject({ kind: 'retry', message: expect.stringContaining('Cannot reach the server') });
    expect(describeError(new InsecureServerUrlError('http://x'))).toMatchObject({ kind: 'fix-input', message: expect.stringContaining('https://') });
  });

  it('tells sign-in problems from other server answers', () => {
    expect(describeError(err(ErrorCode.UNAUTHORIZED))).toMatchObject({ kind: 'login' });
    expect(describeError(err(ErrorCode.DEVICE_REVOKED))).toMatchObject({ kind: 'login', message: expect.stringContaining('removed') });
    expect(describeError(err(ErrorCode.WRONG_PASSWORD, 'm', 403))).toMatchObject({ kind: 'fix-input', message: expect.stringContaining('password') });
    expect(describeError(err(ErrorCode.QUOTA_EXCEEDED, 'm', 413))).toMatchObject({ kind: 'none', message: expect.stringContaining('quota') });
    expect(describeError(err(ErrorCode.RATE_LIMITED, 'm', 429, 7000))).toMatchObject({ kind: 'retry', message: expect.stringContaining('7 seconds') });
    expect(describeError(err(ErrorCode.INTERNAL, 'boom', 500))).toMatchObject({ kind: 'retry' });
    expect(describeError(err(ErrorCode.INVALID, 'the username is taken'))).toMatchObject({ kind: 'fix-input', message: 'The server refused this: the username is taken' });
  });

  it('explains key problems', () => {
    expect(describeError(new CryptoError('bad tag'))).toMatchObject({ kind: 'fix-input', message: expect.stringContaining('passphrase') });
    expect(describeError(new Argon2TooCostlyError({ memoryKib: 1 << 22, iterations: 99, parallelism: 1 }))).toMatchObject({ message: expect.stringContaining('memory') });
    expect(describeError(new InvalidRecoveryWordsError()).message).toContain('recovery words');
    expect(describeError(new MissingEpochKeyError(3)).message).toMatch(/key/);
  });

  it('keeps the wording of history errors and shows unknown errors', () => {
    expect(describeError(new UnsyncedChangesError('a.md'))).toMatchObject({ kind: 'retry', message: expect.stringContaining('not synced yet') });
    expect(describeError(new PathOccupiedError('a.md', 'A.md')).message).toContain('A.md');
    expect(describeError(new NotInTrashError('a.md')).message).toContain('exists again');
    expect(describeError(new Error('disk full'))).toEqual({ kind: 'none', message: 'Something went wrong: disk full' });
    expect(describeError('plain string')).toEqual({ kind: 'none', message: 'Something went wrong: plain string' });
  });
});
