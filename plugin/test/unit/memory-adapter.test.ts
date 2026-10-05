import { describe, expect, it } from 'vitest';
import { ManualClock } from '../../src/util/clock';
import type { AdapterEvent } from '../../src/vault/adapter';
import { MemoryAdapter } from '../../src/vault/memory';

const t = (s: string) => new TextEncoder().encode(s);

describe('MemoryAdapter', () => {
  it('reports events and honours write preconditions', async () => {
    const a = new MemoryAdapter(false, new ManualClock(1000));
    const ev: AdapterEvent[] = [];
    a.watch((e) => ev.push(e));
    expect(await a.write('x.md', t('1'), { absent: true })).toBe(true);
    const st = (await a.stat('x.md'))!;
    expect(await a.write('x.md', t('2'), { absent: true })).toBe(false);
    expect(await a.write('x.md', t('2'), { mtime: st.mtime, size: st.size })).toBe(true);
    expect(await a.write('x.md', t('3'), { mtime: st.mtime, size: st.size })).toBe(false);
    await a.rename('x.md', 'y.md');
    expect(await a.remove('y.md', { absent: true })).toBe(false);
    expect(await a.remove('y.md')).toBe(true);
    expect(ev).toEqual([
      { type: 'create', path: 'x.md' },
      { type: 'modify', path: 'x.md' },
      { type: 'rename', path: 'y.md', oldPath: 'x.md' },
      { type: 'delete', path: 'y.md' },
    ]);
  });

  it('gives every write a later mtime even when the clock stands still', async () => {
    const a = new MemoryAdapter(false, new ManualClock(1000));
    await a.write('x', t('a'));
    const m1 = (await a.stat('x'))!.mtime;
    await a.write('x', t('b'));
    expect((await a.stat('x'))!.mtime).toBeGreaterThan(m1);
  });

  it('acts like a case-insensitive file system when asked, including case-only renames', async () => {
    const a = new MemoryAdapter(true);
    await a.write('Readme.md', t('x'));
    expect((await a.stat('README.md'))?.path).toBe('Readme.md');
    await a.write('README.md', t('y'));
    expect(await a.list()).toEqual(['Readme.md']);
    expect(await a.rename('Readme.md', 'README.md')).toBe(true);
    expect(await a.list()).toEqual(['README.md']);
  });

  it('refuses a rename onto another file or against a stale precondition', async () => {
    const a = new MemoryAdapter();
    await a.write('a.md', t('a'));
    await a.write('b.md', t('b'));
    expect(await a.rename('a.md', 'b.md')).toBe(false);
    expect(await a.rename('a.md', 'c.md', { absent: true })).toBe(false);
    expect(await a.rename('missing.md', 'd.md')).toBe(false);
  });

  it('can simulate an I/O error, which read reports by throwing', async () => {
    const a = new MemoryAdapter();
    await a.write('a.md', t('a'));
    a.failReads('a.md');
    await expect(a.read('a.md')).rejects.toThrow(/EIO/);
    a.failReads('a.md', false);
    expect(await a.read('a.md')).toEqual(t('a'));
  });
});
