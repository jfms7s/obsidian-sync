import { describe, expect, it } from 'vitest';
import { createEngineLock, type LockManagerLike } from '../../src/shell/engine-lock';
import { formatIgnoreText, parseIgnoreText } from '../../src/shell/ignore-text';

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

/** Just enough of navigator.locks: exclusive locks per name, granted in request order. */
function fakeLocks(): LockManagerLike {
  const tails = new Map<string, Promise<unknown>>();
  return {
    request: (name, callback) => {
      const prev = tails.get(name) ?? Promise.resolve();
      const run = prev.then(() => callback());
      tails.set(name, run.catch(() => undefined));
      return run;
    },
  };
}

describe.each([
  ['navigator.locks', () => ({ locks: fakeLocks() })],
  ['the fallback queue', () => ({ locks: null, registry: new Map<string, Promise<void>>() })],
])('createEngineLock over %s', (_name, deps) => {
  it('lets the first caller in at once and the next only after the first releases', async () => {
    const d = deps();
    const a = createEngineLock('vault-1', d);
    const b = createEngineLock('vault-1', d); // another plugin instance, as after a reload
    const releaseA = await a.acquire();
    let bHeld = false;
    const waiting = b.acquire().then((release) => {
      bHeld = true;
      return release;
    });
    await flush();
    expect(bHeld).toBe(false);
    releaseA();
    const releaseB = await waiting;
    expect(bHeld).toBe(true);
    releaseB();
  });

  it('does not make different vaults wait for each other', async () => {
    const d = deps();
    const one = await createEngineLock('vault-1', d).acquire();
    const two = await createEngineLock('vault-2', d).acquire();
    one();
    two();
  });

  it('serves several waiters in order, and releasing twice does no harm', async () => {
    const d = deps();
    const order: number[] = [];
    const first = await createEngineLock('v', d).acquire();
    const w2 = createEngineLock('v', d).acquire().then((r) => {
      order.push(2);
      return r;
    });
    const w3 = createEngineLock('v', d).acquire().then((r) => {
      order.push(3);
      return r;
    });
    first();
    first();
    (await w2)();
    (await w3)();
    expect(order).toEqual([2, 3]);
  });
});

describe('ignore text', () => {
  it('collects globs and reports problems with the line numbers of the text, blank and comment lines counted', () => {
    const text = '# my rules\nScratch/\n\n!keep.md\n*.log\n[abc]\n';
    expect(parseIgnoreText(text)).toEqual({
      globs: ['Scratch/', '*.log'],
      errors: [
        { line: 4, text: '!keep.md', message: 'negation ("!") is not supported' },
        { line: 6, text: '[abc]', message: 'character classes ("[...]") are not supported' },
      ],
    });
  });

  it('handles Windows line endings, indentation and empty text', () => {
    expect(parseIgnoreText('  a/  \r\nb\r\n')).toEqual({ globs: ['a/', 'b'], errors: [] });
    expect(parseIgnoreText('')).toEqual({ globs: [], errors: [] });
  });

  it('formats globs one per line', () => {
    expect(formatIgnoreText(['a/', 'b'])).toBe('a/\nb');
  });
});
