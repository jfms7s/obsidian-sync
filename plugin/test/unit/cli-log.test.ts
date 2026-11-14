import { describe, expect, it } from 'vitest';
import { errorKind } from '../../cli/log';
import { ApiError, ErrorCode } from '../../src/index';

describe('errorKind', () => {
  it('errorKind keeps the kind and drops the path', () => {
    const e = Object.assign(new Error("ENOENT: no such file or directory, open '/vault/mimir/Title.md'"), { code: 'ENOENT' });
    expect(errorKind(e)).toBe('Error ENOENT');
    expect(errorKind(new TypeError('/vault/mimir/x'))).toBe('TypeError');
    expect(errorKind('mimir/x.md')).toBe('unknown error');
  });

  it('names an ApiError by its code', () => {
    expect(errorKind(new ApiError(ErrorCode.QUOTA_EXCEEDED, 'mimir/Title.md is too large', 413))).toBe('ApiError QUOTA_EXCEEDED');
  });
});
