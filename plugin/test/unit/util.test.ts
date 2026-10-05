import { describe, expect, it } from 'vitest';
import { backoffDelay } from '../../src/util/backoff';
import { concat, equalBytes, fromHex, fromUtf8Strict, toHex, u32be } from '../../src/util/bytes';
import { ManualClock } from '../../src/util/clock';
import { CONFLICT_COPY_PATTERN, caseFold, conflictCopyName, normalizePath, splitPath } from '../../src/util/path';
import { seededRandom } from '../../src/util/random';

describe('bytes', () => {
  it('round-trips lowercase hex and rejects anything else', () => {
    expect(toHex(fromHex('00ff7a'))).toBe('00ff7a');
    expect(() => fromHex('00FF')).toThrow();
    expect(() => fromHex('abc')).toThrow();
  });
  it('encodes u32 big-endian', () => {
    expect(toHex(u32be(1))).toBe('00000001');
    expect(toHex(u32be(0xfffffffe))).toBe('fffffffe');
    expect(() => u32be(-1)).toThrow(RangeError);
  });
  it('concatenates and compares', () => {
    expect(equalBytes(concat(new Uint8Array([1]), new Uint8Array([2, 3])), new Uint8Array([1, 2, 3]))).toBe(true);
    expect(equalBytes(new Uint8Array([1]), new Uint8Array([1, 2]))).toBe(false);
  });
  it('detects invalid UTF-8', () => {
    expect(fromUtf8Strict(new Uint8Array([0xc3, 0xa9]))).toBe('é');
    expect(fromUtf8Strict(new Uint8Array([0xff, 0xfe]))).toBeNull();
  });
});

describe('paths', () => {
  it('normalizes to NFC with forward slashes', () => {
    expect(normalizePath('a\\b\\Café.md')).toBe('a/b/Café.md');
  });
  it.each(['', '/abs.md', 'dir/', 'a//b.md', './a.md', 'a/../b.md', 'tab\there.md'])('rejects %j', (p) => {
    expect(() => normalizePath(p)).toThrow();
  });
  it('splits names, treating dotfiles as extensionless', () => {
    expect(splitPath('a/b.c.md')).toEqual({ dir: 'a/', stem: 'b.c', ext: '.md' });
    expect(splitPath('.gitignore')).toEqual({ dir: '', stem: '.gitignore', ext: '' });
  });
  it('names conflict copies and numbers repeats', () => {
    const ms = Date.UTC(2026, 9, 4, 13, 5);
    expect(conflictCopyName('Notes/My note.md', 'Pixel 9', ms)).toBe('Notes/My note (conflict Pixel 9 2026-10-04 1305).md');
    expect(conflictCopyName('Notes/My note.md', 'a/b:c', ms, 2)).toBe('Notes/My note (conflict a-b-c 2026-10-04 1305 2).md');
    expect(conflictCopyName('README', 'x', ms)).toBe('README (conflict x 2026-10-04 1305)');
    expect(CONFLICT_COPY_PATTERN.test('Notes/My note (conflict Pixel 9 2026-10-04 1305).md')).toBe(true);
    expect(CONFLICT_COPY_PATTERN.test('Notes/My note.md')).toBe(false);
  });
  it('folds case for collision checks', () => {
    expect(caseFold('Readme.MD')).toBe(caseFold('readme.md'));
  });
});

describe('seeded random', () => {
  it('replays exactly from a seed', () => {
    const a = seededRandom(42), b = seededRandom(42), c = seededRandom(43);
    expect(toHex(a.bytes(16))).toBe(toHex(b.bytes(16)));
    expect(a.float()).toBe(b.float());
    expect(toHex(seededRandom(42).bytes(8))).not.toBe(toHex(c.bytes(8)));
  });
});

describe('backoff', () => {
  it('grows exponentially with jitter and caps', () => {
    const r = seededRandom(1);
    const p = { baseMs: 1000, maxMs: 60_000 };
    for (let n = 0; n < 12; n++) {
      const d = backoffDelay(n, r, p);
      const full = Math.min(60_000, 1000 * 2 ** n);
      expect(d).toBeGreaterThanOrEqual(full / 2);
      expect(d).toBeLessThan(full);
    }
  });
  it('never waits less than Retry-After', () => {
    expect(backoffDelay(0, seededRandom(1), { baseMs: 10, maxMs: 100 }, 30_000)).toBe(30_000);
  });
});

describe('manual clock', () => {
  it('fires timers in due order as time advances', () => {
    const c = new ManualClock(0);
    const fired: string[] = [];
    c.setTimeout(() => fired.push('b'), 20);
    const h = c.setTimeout(() => fired.push('x'), 5);
    c.setTimeout(() => fired.push('a'), 10);
    c.clearTimeout(h);
    c.advance(15);
    expect(fired).toEqual(['a']);
    c.advance(10);
    expect(fired).toEqual(['a', 'b']);
    expect(c.now()).toBe(25);
  });
});
