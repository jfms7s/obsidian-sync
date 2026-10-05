import type { FileManager as RealFileManager, Vault as RealVault } from 'obsidian';
import { describe, expect, it, vi } from 'vitest';
import { ObsidianAdapter, TEMP_SUFFIX } from '../../src/shell/obsidian-adapter';
import type { AdapterEvent } from '../../src/vault/adapter';
import { describeAdapterContract, type ContractFixture } from '../contract/adapter-contract';
import { FileManager, Outside, TFolder, Vault, type TrashPreference, type VaultOptions } from '../fakes/obsidian';

const bytes = (s: string) => new TextEncoder().encode(s);
const PROBE_DIR = '.obsidian/plugins/obsync';

async function build(o: VaultOptions & { trash?: TrashPreference } = {}) {
  const vault = new Vault(o);
  const fileManager = new FileManager(vault, o.trash ?? 'system');
  const adapter = await ObsidianAdapter.create(vault as unknown as RealVault, PROBE_DIR, fileManager as unknown as RealFileManager);
  const outside = new Outside(vault);
  const fixture: ContractFixture = { adapter, outside: (p, d) => outside.write(p, d), settle: async () => vault.flushWatcher() };
  return { vault, adapter, outside, fixture };
}

// Every platform situation the adapter has to work in.
const CONFIGS: Array<[string, VaultOptions, { caseInsensitive: boolean; nfdOnDisk?: boolean }]> = [
  ['Linux disk, index in step', {}, { caseInsensitive: false, nfdOnDisk: true }],
  ['Linux disk, index lagging', { index: 'lagging' }, { caseInsensitive: false, nfdOnDisk: true }],
  ['Android: no index for outside changes', { index: 'none' }, { caseInsensitive: false }],
  ['Linux disk, no events for the files in a folder', { childEvents: false }, { caseInsensitive: false }],
  ['Windows disk (case-insensitive)', { caseInsensitive: true }, { caseInsensitive: true }],
  ['Windows disk with whole-second mtimes', { caseInsensitive: true, mtimeGranularityMs: 2000 }, { caseInsensitive: true }],
  ['macOS disk (case- and normalization-insensitive), index lagging', { caseInsensitive: true, normalizationInsensitive: true, index: 'lagging' }, { caseInsensitive: true, nfdOnDisk: true }],
  ['iOS: case-insensitive, no index for outside changes', { caseInsensitive: true, index: 'none' }, { caseInsensitive: true }],
];

for (const [name, vaultOptions, contract] of CONFIGS) {
  describeAdapterContract(`ObsidianAdapter, ${name}`, async () => (await build(vaultOptions)).fixture, contract);
}

describe('ObsidianAdapter', () => {
  it('detects the disk\'s case sensitivity with a probe it removes again', async () => {
    for (const caseInsensitive of [false, true]) {
      const { vault, adapter } = await build({ caseInsensitive });
      expect(adapter.caseInsensitive).toBe(caseInsensitive);
      expect(vault.fs.paths().filter((p) => p.includes('Probe'))).toEqual([]);
    }
  });

  it('writes indexed files through the Vault API, so Obsidian\'s index is right even when it never sees outside changes', async () => {
    const { vault, adapter } = await build({ index: 'none' });
    await adapter.write('Notes/n.md', bytes('1'));
    expect(vault.getFileByPath('Notes/n.md')).not.toBeNull();
    await adapter.write('Notes/n.md', bytes('22'));
    expect(vault.getFileByPath('Notes/n.md')!.stat.size).toBe(2);
    await adapter.rename('Notes/n.md', 'Notes/m.md');
    expect(vault.getFileByPath('Notes/m.md')).not.toBeNull();
    expect(vault.getFileByPath('Notes/n.md')).toBeNull();
  });

  it('writes hidden files through the disk and keeps them out of the index', async () => {
    const { vault, adapter } = await build();
    await adapter.write('.config/x.json', bytes('{}'));
    expect(vault.fs.paths()).toContain('.config/x.json');
    expect(vault.getFileByPath('.config/x.json')).toBeNull();
    expect(await adapter.list()).toEqual(['.config/x.json']);
  });

  it('deletes indexed files the way the user\'s Obsidian setting says, and unindexed ones to a trash', async () => {
    for (const [trash, expected] of [['system', 'system'], ['local', '.trash'], ['permanent', 'gone']] as const) {
      const { vault, adapter } = await build({ trash });
      await adapter.write('a.md', bytes('kept'));
      await adapter.remove('a.md');
      expect(await adapter.list()).toEqual(expected === '.trash' ? ['.trash/a.md'] : []);
      expect(vault.systemTrashed.length).toBe(expected === 'system' ? 1 : 0);
    }
  });

  it('moves files the index does not know to the system trash, or to .trash when there is none, never deleting for good', async () => {
    const withSystem = await build({ systemTrash: true, index: 'lagging' });
    withSystem.outside.write('a.md', bytes('kept'));
    withSystem.outside.write('b.md', bytes('also kept')); // not indexed: the disk route
    await withSystem.adapter.remove('a.md');
    await withSystem.adapter.remove('b.md');
    expect(withSystem.vault.systemTrashed.map((t) => `${t.path}:${new TextDecoder().decode(t.data!)}`).sort()).toEqual(['a.md:kept', 'b.md:also kept']);

    const local = await build({ systemTrash: false, index: 'lagging' });
    local.outside.write('a.md', bytes('kept'));
    local.outside.write('b.md', bytes('also kept'));
    await local.adapter.remove('a.md');
    await local.adapter.remove('b.md');
    expect(await local.adapter.list()).toEqual(['.trash/a.md', '.trash/b.md']);
    expect(new TextDecoder().decode(local.vault.fs.read('.trash/a.md'))).toBe('kept');
  });

  it('replaces an empty folder, indexed or not, when a file takes its name', async () => {
    const { vault, adapter } = await build();
    await vault.createFolder('indexed');
    vault.fs.mkdir('plain'); // on disk only
    expect(await adapter.hasFolder('indexed')).toBe(false);
    expect(await adapter.write('indexed', bytes('file'))).toBe(true);
    expect(await adapter.write('plain', bytes('file'))).toBe(true);
    expect(await adapter.list()).toEqual(['indexed', 'plain']);
    await vault.createFolder('empty-target');
    await adapter.write('src.md', bytes('s'));
    expect(await adapter.rename('src.md', 'empty-target')).toBe(true);
    expect(await adapter.list()).toEqual(['empty-target', 'indexed', 'plain']);
  });

  it('puts a new file into the folder that exists under another normalization instead of creating a second one', async () => {
    const { vault, adapter, outside } = await build();
    const dir = 'Café';
    outside.write(`${dir.normalize('NFD')}/old.md`, bytes('old'));
    await adapter.write(`${dir}/new.md`, bytes('new'));
    expect(vault.fs.paths().filter((p) => !p.includes('/'))).toEqual([dir.normalize('NFD'), '.obsidian'].sort());
    expect(await adapter.list()).toEqual([`${dir}/new.md`, `${dir}/old.md`]);
  });

  describe('case-only renames on a case-insensitive disk, which Obsidian itself refuses', () => {
    it('go through a temporary name', async () => {
      const { vault, adapter } = await build({ caseInsensitive: true });
      await adapter.write('todo.md', bytes('- milk'));
      const spy = vi.spyOn(vault, 'rename');
      expect(await adapter.rename('todo.md', 'TODO.md')).toBe(true);
      expect(spy.mock.calls.map((c) => c[1])).toEqual(['TODO.md', `TODO.md${TEMP_SUFFIX}`, 'TODO.md']);
      expect(vault.fs.paths().filter((p) => !p.startsWith('.'))).toEqual(['TODO.md']);
    });

    it('are finished by the next listing when the app dies between the two steps', async () => {
      const { vault, adapter } = await build({ caseInsensitive: true });
      await adapter.write('todo.md', bytes('- milk'));
      const real = vault.rename.bind(vault);
      let calls = 0;
      vi.spyOn(vault, 'rename').mockImplementation(async (file, to) => {
        if (++calls === 3) throw new Error('the app was killed');
        return real(file, to);
      });
      await expect(adapter.rename('todo.md', 'TODO.md')).rejects.toThrow('killed');
      expect(vault.fs.paths().filter((p) => !p.startsWith('.'))).toEqual([`TODO.md${TEMP_SUFFIX}`]);
      expect(await adapter.list()).toEqual(['TODO.md']);
      expect(new TextDecoder().decode((await adapter.read('TODO.md'))!)).toBe('- milk');
      expect(vault.fs.paths().filter((p) => !p.startsWith('.'))).toEqual(['TODO.md']);
    });

    it('also work for a file the index does not know', async () => {
      const { vault, adapter, outside } = await build({ caseInsensitive: true, index: 'lagging' });
      outside.write('todo.md', bytes('x'));
      expect(vault.getFileByPath('todo.md')).toBeNull();
      expect(await adapter.rename('todo.md', 'TODO.md')).toBe(true);
      expect(await adapter.list()).toEqual(['TODO.md']);
    });
  });

  it('refuses a rename onto another file that differs only in case on a case-sensitive disk', async () => {
    for (const o of [{}, { index: 'lagging' as const }]) {
      const { adapter, outside } = await build(o);
      outside.write('Readme.md', bytes('mine'));
      outside.write('README.md', bytes('theirs'));
      if (!o.index) {
        await adapter.write('Readme.md', bytes('mine'));
        await adapter.write('README.md', bytes('theirs'));
      }
      expect(await adapter.rename('Readme.md', 'README.md')).toBe(false);
      expect((await adapter.list()).sort()).toEqual(['README.md', 'Readme.md']);
      expect(new TextDecoder().decode((await adapter.read('Readme.md'))!)).toBe('mine');
      expect(new TextDecoder().decode((await adapter.read('README.md'))!)).toBe('theirs');
    }
  });

  describe('events for folders', () => {
    for (const childEvents of [true, false]) {
      it(`give one event per file when a folder is renamed or deleted (Obsidian ${childEvents ? 'reports' : 'does not report'} the files in it)`, async () => {
        const { vault, adapter } = await build({ childEvents });
        await adapter.write('dir/a.md', bytes('a'));
        await adapter.write('dir/sub/b.md', bytes('b'));
        const events: AdapterEvent[] = [];
        adapter.watch((e) => events.push(e));
        await vault.rename(vault.getFolderByPath('dir')!, 'moved');
        const renames = events.filter((e) => e.type === 'rename').map((e) => `${(e as { oldPath: string }).oldPath}>${e.path}`);
        expect([...new Set(renames)].sort()).toEqual(['dir/a.md>moved/a.md', 'dir/sub/b.md>moved/sub/b.md']);
        events.length = 0;
        await vault.delete(vault.getAbstractFileByPath('moved') as TFolder, true);
        expect([...new Set(events.filter((e) => e.type === 'delete').map((e) => e.path))].sort()).toEqual(['moved/a.md', 'moved/sub/b.md']);
      });
    }

    it('report a file Obsidian indexes late, once its watcher catches up', async () => {
      const { adapter, outside, fixture } = await build({ index: 'lagging' });
      const events: AdapterEvent[] = [];
      adapter.watch((e) => events.push(e));
      outside.write('late.md', bytes('x'));
      expect(events).toEqual([]);
      await fixture.settle();
      expect(events).toEqual([{ type: 'create', path: 'late.md' }]);
    });
  });
});
