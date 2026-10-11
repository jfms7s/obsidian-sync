// The fake obsidian module (test/fakes/obsidian.ts) must report what
// Obsidian reports, or the shell's adapter is tested against the wrong
// events.
import { describe, expect, it } from 'vitest';
import { TFile, Vault, type TAbstractFile } from '../fakes/obsidian';

const buf = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;

describe('fake obsidian Vault', () => {
  it('reports the files in a deleted folder with the nodes it indexed, and nothing for hidden ones', async () => {
    const vault = new Vault({ childEvents: true });
    const folder = await vault.createFolder('F');
    const file = await vault.createBinary('F/a.md', buf('a'));
    await vault.adapter.mkdir('F/.cache');
    await vault.adapter.writeBinary('F/.cache/x', buf('x'));
    const deleted: TAbstractFile[] = [];
    vault.on('delete', (n: TAbstractFile) => deleted.push(n));
    await vault.delete(folder, true);
    expect(deleted).toContain(file);
    expect(deleted).toContain(folder);
    expect(deleted.map((n) => n.path).sort()).toEqual(['F', 'F/a.md']);
  });

  for (const index of ['sync', 'lagging'] as const) {
    it(`drops a file renamed behind its back to a hidden path from the index (index ${index})`, async () => {
      const vault = new Vault({ index });
      const file = await vault.createBinary('a.md', buf('a'));
      await vault.adapter.mkdir('.h');
      const deleted: TAbstractFile[] = [];
      vault.on('delete', (n: TAbstractFile) => deleted.push(n));
      await vault.adapter.rename('a.md', '.h/a.md');
      vault.flushWatcher();
      expect(vault.getAbstractFileByPath('a.md')).toBeNull();
      expect(vault.getFiles()).toEqual([]);
      expect(deleted).toEqual([file]);
      expect(file).toBeInstanceOf(TFile);
    });
  }
});
