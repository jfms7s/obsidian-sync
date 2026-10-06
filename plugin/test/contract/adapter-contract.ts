// What every VaultAdapter must do (vault/adapter.ts), as one suite that runs
// against MemoryAdapter and against ObsidianAdapter over the fake `obsidian`
// module in each configuration the real thing can be in. Anything the engine
// relies on belongs here, so a new adapter cannot pass without it.
import { describe, expect, it } from 'vitest';
import type { AdapterEvent, VaultAdapter } from '../../src/vault/adapter';

export interface ContractFixture {
  adapter: VaultAdapter;
  /**
   * Puts a file on the disk behind the adapter's back, spelled exactly as
   * given: another program editing the vault folder, or a name the file
   * system stores in another normalization.
   */
  outside(path: string, data: Uint8Array): void | Promise<void>;
  /** Lets the host's file watcher catch up with changes made behind the adapter's back. */
  settle(): Promise<void>;
}

export interface ContractOptions {
  /** The adapter reports caseInsensitive = true. */
  caseInsensitive: boolean;
  /** Names are stored in NFD on this disk (written with `outside`), while the engine asks for NFC. */
  nfdOnDisk?: boolean;
}

const bytes = (s: string) => new TextEncoder().encode(s);
const str = (b: Uint8Array | null) => (b === null ? null : new TextDecoder().decode(b));

export function describeAdapterContract(name: string, make: () => Promise<ContractFixture>, o: ContractOptions): void {
  describe(`VaultAdapter contract: ${name}`, () => {
    it('reports its case sensitivity', async () => {
      expect((await make()).adapter.caseInsensitive).toBe(o.caseInsensitive);
    });

    it('creates a file with its folders, then reads, stats and lists it', async () => {
      const { adapter } = await make();
      expect(await adapter.write('a/b/c.md', bytes('hello'))).toBe(true);
      expect(str(await adapter.read('a/b/c.md'))).toBe('hello');
      expect(await adapter.stat('a/b/c.md')).toMatchObject({ path: 'a/b/c.md', size: 5 });
      expect(await adapter.list()).toEqual(['a/b/c.md']);
      expect(await adapter.read('a/missing.md')).toBeNull();
      expect(await adapter.stat('a/missing.md')).toBeNull();
      expect(await adapter.stat('a/b')).toBeNull(); // a folder is not a file
    });

    it('overwrites in place with a newer mtime', async () => {
      const { adapter } = await make();
      await adapter.write('n.md', bytes('one'));
      const before = (await adapter.stat('n.md'))!;
      expect(await adapter.write('n.md', bytes('two!'))).toBe(true);
      const after = (await adapter.stat('n.md'))!;
      expect(str(await adapter.read('n.md'))).toBe('two!');
      expect(after.size).toBe(4);
      expect(after.mtime).toBeGreaterThanOrEqual(before.mtime);
      expect(await adapter.list()).toEqual(['n.md']);
    });

    it('honours write preconditions and leaves the file alone when they fail', async () => {
      const { adapter } = await make();
      expect(await adapter.write('n.md', bytes('1'), { absent: true })).toBe(true);
      expect(await adapter.write('n.md', bytes('2'), { absent: true })).toBe(false);
      const st = (await adapter.stat('n.md'))!;
      expect(await adapter.write('n.md', bytes('3'), { mtime: st.mtime, size: st.size + 1 })).toBe(false);
      expect(await adapter.write('n.md', bytes('4'), { mtime: st.mtime, size: st.size })).toBe(true);
      expect(await adapter.write('missing.md', bytes('x'), { mtime: 1, size: 1 })).toBe(false);
      expect(str(await adapter.read('n.md'))).toBe('4');
      expect(await adapter.read('missing.md')).toBeNull();
    });

    it('removes files, with preconditions; removing a missing file is fine', async () => {
      const { adapter } = await make();
      await adapter.write('n.md', bytes('1'));
      const st = (await adapter.stat('n.md'))!;
      expect(await adapter.remove('n.md', { absent: true })).toBe(false);
      expect(await adapter.remove('n.md', { mtime: st.mtime, size: st.size + 1 })).toBe(false);
      expect(await adapter.stat('n.md')).not.toBeNull();
      expect(await adapter.remove('n.md', { mtime: st.mtime, size: st.size })).toBe(true);
      expect(await adapter.stat('n.md')).toBeNull();
      expect(await adapter.remove('n.md')).toBe(true);
    });

    it('renames a file keeping its content and mtime, creating folders for the new name', async () => {
      const { adapter } = await make();
      await adapter.write('old.md', bytes('body'));
      const before = (await adapter.stat('old.md'))!;
      expect(await adapter.rename('old.md', 'new/dir/name.md')).toBe(true);
      expect(await adapter.stat('old.md')).toBeNull();
      expect(str(await adapter.read('new/dir/name.md'))).toBe('body');
      expect((await adapter.stat('new/dir/name.md'))!.mtime).toBe(before.mtime);
    });

    it('refuses a rename onto another file, from a missing file, or against a stale precondition', async () => {
      const { adapter } = await make();
      await adapter.write('a.md', bytes('a'));
      await adapter.write('b.md', bytes('b'));
      const st = (await adapter.stat('a.md'))!;
      expect(await adapter.rename('a.md', 'b.md')).toBe(false);
      expect(await adapter.rename('missing.md', 'c.md')).toBe(false);
      expect(await adapter.rename('a.md', 'c.md', { mtime: st.mtime, size: st.size + 1 })).toBe(false);
      expect(await adapter.rename('a.md', 'c.md', { absent: true })).toBe(false);
      expect(await adapter.list()).toEqual(['a.md', 'b.md']);
      expect(str(await adapter.read('b.md'))).toBe('b');
    });

    it('has a folder only while a file lives below it, and refuses a file over a folder or below a file', async () => {
      const { adapter } = await make();
      expect(await adapter.hasFolder('docs')).toBe(false);
      await adapter.write('docs/x.md', bytes('x'));
      await adapter.write('note', bytes('n'));
      expect(await adapter.hasFolder('docs')).toBe(true);
      expect(await adapter.hasFolder('docs/x.md')).toBe(false);
      expect(await adapter.hasFolder('note')).toBe(false);
      expect(await adapter.hasFolder('doc')).toBe(false);
      await expect(adapter.write('docs', bytes('file'))).rejects.toThrow();
      await expect(adapter.write('note/child.md', bytes('x'))).rejects.toThrow();
      await expect(adapter.rename('note', 'docs')).rejects.toThrow();
      await adapter.remove('docs/x.md');
      expect(await adapter.hasFolder('docs')).toBe(false);
      expect(await adapter.list()).toEqual(['note']);
    });

    it('treats names that differ only in case the way its file system does', async () => {
      const { adapter } = await make();
      await adapter.write('Readme.md', bytes('first'));
      await adapter.write('README.md', bytes('second'));
      if (o.caseInsensitive) {
        expect(await adapter.list()).toEqual(['Readme.md']); // the second write went to the same file
        expect(str(await adapter.read('README.md'))).toBe('second');
        expect(await adapter.stat('readme.md')).toMatchObject({ path: 'Readme.md' }); // the name as stored
      } else {
        expect(await adapter.list()).toEqual(['README.md', 'Readme.md']);
        expect(await adapter.stat('readme.md')).toBeNull();
      }
    });

    it('renames only the case of a file, in place', async () => {
      const { adapter } = await make();
      await adapter.write('todo.md', bytes('- milk'));
      expect(await adapter.rename('todo.md', 'TODO.md')).toBe(true);
      expect(await adapter.list()).toEqual(['TODO.md']);
      expect(str(await adapter.read('TODO.md'))).toBe('- milk');
      expect(await adapter.rename('TODO.md', 'Todo.md', { absent: true })).toBe(false);
      expect(await adapter.list()).toEqual(['TODO.md']);
    });

    it('reports every change it makes, as one event per file, and stops when unsubscribed', async () => {
      const { adapter, settle } = await make();
      const events: AdapterEvent[] = [];
      const off = adapter.watch((e) => events.push(e));
      await adapter.write('x.md', bytes('1'));
      await adapter.write('x.md', bytes('22'));
      await adapter.rename('x.md', 'y.md');
      await adapter.remove('y.md');
      await settle();
      const kinds = events.map((e) => e.type);
      // An adapter may report more than it must (a write as create + modify), never less.
      expect(kinds).toContain('create');
      expect(kinds).toContain('modify');
      expect(kinds).toContain('rename');
      expect(kinds).toContain('delete');
      expect(events).toContainEqual({ type: 'rename', path: 'y.md', oldPath: 'x.md' });
      expect(events).toContainEqual({ type: 'delete', path: 'y.md' });
      const count = events.length;
      off();
      await adapter.write('z.md', bytes('z'));
      await settle();
      expect(events).toHaveLength(count);
    });

    it('sees files that appeared behind its back, even before the host has indexed them', async () => {
      const { adapter, outside, settle } = await make();
      await outside('Notes/new.md', bytes('from elsewhere'));
      expect(await adapter.list()).toEqual(['Notes/new.md']);
      expect(await adapter.stat('Notes/new.md')).toMatchObject({ path: 'Notes/new.md', size: 14 });
      expect(str(await adapter.read('Notes/new.md'))).toBe('from elsewhere');
      expect(await adapter.hasFolder('Notes')).toBe(true);
      // Writing, renaming and removing such a file works like for any other.
      expect(await adapter.write('Notes/new.md', bytes('replaced'))).toBe(true);
      expect(str(await adapter.read('Notes/new.md'))).toBe('replaced');
      expect(await adapter.rename('Notes/new.md', 'Notes/moved.md')).toBe(true);
      expect(await adapter.remove('Notes/moved.md')).toBe(true);
      await settle();
      expect(await adapter.list()).toEqual([]);
    });

    it('writes a new file where the host has an unindexed one of that name', async () => {
      const { adapter, outside } = await make();
      await outside('late.md', bytes('already there'));
      expect(await adapter.write('late.md', bytes('mine'), { absent: true })).toBe(false);
      expect(await adapter.write('late.md', bytes('mine'))).toBe(true);
      expect(str(await adapter.read('late.md'))).toBe('mine');
    });

    it('lists hidden files and folders too, and skips the folders it is told to', async () => {
      const { adapter, outside } = await make();
      await outside('.hidden/secret.md', bytes('s'));
      await outside('.git/objects/ab', bytes('g'));
      await adapter.write('Notes/a.md', bytes('a'));
      await adapter.write('Scratch/b.md', bytes('b'));
      expect(await adapter.list()).toEqual(['.git/objects/ab', '.hidden/secret.md', 'Notes/a.md', 'Scratch/b.md']);
      const asked: string[] = [];
      const listed = await adapter.list((folder) => {
        asked.push(folder);
        return folder === '.git' || folder === 'Scratch';
      });
      expect(listed).toEqual(['.hidden/secret.md', 'Notes/a.md']);
      expect(asked).not.toContain('.git/objects'); // a skipped folder is not entered
    });

    if (o.nfdOnDisk) {
      it('maps names stored in NFD to the NFC paths the engine uses, without making a second file', async () => {
        const { adapter, outside } = await make();
        const nfc = 'Café/Résumé.md';
        const nfd = nfc.normalize('NFD');
        expect(nfd).not.toBe(nfc);
        await outside(nfd, bytes('on disk'));
        expect(await adapter.list()).toEqual([nfc]);
        expect(await adapter.stat(nfc)).toMatchObject({ path: nfc, size: 7 });
        expect(str(await adapter.read(nfc))).toBe('on disk');
        expect(await adapter.hasFolder('Café')).toBe(true);
        expect(await adapter.write(nfc, bytes('rewritten'))).toBe(true);
        expect(await adapter.list()).toEqual([nfc]); // still one file
        expect(str(await adapter.read(nfc))).toBe('rewritten');
        expect(await adapter.rename(nfc, 'Café/Menu.md')).toBe(true);
        expect(await adapter.list()).toEqual(['Café/Menu.md']);
        expect(await adapter.remove('Café/Menu.md')).toBe(true);
        expect(await adapter.list()).toEqual([]);
      });

      it('reports events for NFD-named files under their NFC path', async () => {
        const { adapter, outside, settle } = await make();
        const nfc = 'Café.md';
        await outside(nfc.normalize('NFD'), bytes('x'));
        const events: AdapterEvent[] = [];
        adapter.watch((e) => events.push(e));
        await adapter.write(nfc, bytes('y'));
        await settle();
        expect(events.length).toBeGreaterThan(0);
        for (const e of events) expect(e.path).toBe(nfc);
      });
    }
  });
}
