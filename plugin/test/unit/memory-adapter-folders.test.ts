import { describe, expect, it } from 'vitest';
import { MemoryAdapter } from '../../src/vault/memory';

const t = (s: string) => new TextEncoder().encode(s);

describe('MemoryAdapter folders', () => {
  it('has a folder exactly when a file lives below it', async () => {
    const a = new MemoryAdapter();
    expect(await a.hasFolder('docs')).toBe(false);
    await a.write('docs/x.md', t('x'));
    expect(await a.hasFolder('docs')).toBe(true);
    expect(await a.hasFolder('docs/x.md')).toBe(false); // a file is not a folder
    expect(await a.hasFolder('doc')).toBe(false); // a prefix is not a folder
    await a.remove('docs/x.md');
    expect(await a.hasFolder('docs')).toBe(false);
  });

  it('folds case in hasFolder on a case-insensitive adapter only', async () => {
    const ci = new MemoryAdapter(true);
    await ci.write('Docs/x.md', t('x'));
    expect(await ci.hasFolder('docs')).toBe(true);
    const cs = new MemoryAdapter(false);
    await cs.write('Docs/x.md', t('x'));
    expect(await cs.hasFolder('docs')).toBe(false);
  });

  it('refuses, like a file system, to write a file where a folder is or below a file', async () => {
    const a = new MemoryAdapter();
    await a.write('docs/x.md', t('x'));
    await expect(a.write('docs', t('file'))).rejects.toThrow(/EISDIR/);
    await a.write('note', t('file'));
    await expect(a.write('note/child.md', t('x'))).rejects.toThrow(/ENOTDIR/);
    await expect(a.rename('note', 'docs')).rejects.toThrow(/EISDIR/);
    await expect(a.rename('docs/x.md', 'note/x.md')).rejects.toThrow(/ENOTDIR/);
    expect(await a.list()).toEqual(['docs/x.md', 'note']);
  });
});
