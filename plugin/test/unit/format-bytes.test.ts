import { describe, expect, it } from 'vitest';
import { formatBytes } from '../../src/shell/format-bytes';

describe('formatBytes', () => {
  it.each([
    [0, '0 B'],
    [1, '1 B'],
    [1023, '1023 B'],
    [1024, '1.0 KB'],
    [1536, '1.5 KB'],
    [9.94 * 1024, '9.9 KB'],
    [9.96 * 1024, '10 KB'], // rounds up out of the one-decimal range
    [10 * 1024, '10 KB'],
    [1023.4 * 1024, '1023 KB'],
    [1023.6 * 1024, '1.0 MB'], // rounds up into the next unit
    [512 * 1024 ** 2, '512 MB'],
    [480.4 * 1024 ** 2, '480 MB'],
    [10 * 1024 ** 3, '10 GB'],
    [2.25 * 1024 ** 4, '2.3 TB'],
    [5000 * 1024 ** 4, '5000 TB'],
  ])('%d bytes is %s', (n, want) => {
    expect(formatBytes(n)).toBe(want);
  });

  it('shows nonsense as 0 B', () => {
    expect(formatBytes(-5)).toBe('0 B');
    expect(formatBytes(Number.NaN)).toBe('0 B');
  });
});
