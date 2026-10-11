// The filesystem adapter obsync-cli syncs a folder with: the adapter
// contract over a real temporary folder, then what only a real disk has
// (other programs' edits seen by the watcher, links, the trash, atomic
// writes).
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FsAdapter, TEMP_PATTERN } from '../../cli/fs-adapter';
import type { AdapterEvent } from '../../src/vault/adapter';
import { describeAdapterContract } from '../contract/adapter-contract';

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function tempDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'obsync-fs-'));
  dirs.push(d);
  return d;
}

const bytes = (s: string) => new TextEncoder().encode(s);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function put(root: string, rel: string, data: string | Uint8Array): Promise<void> {
  const p = join(root, ...rel.split('/'));
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, data);
}

/** Waits for the watcher to hear of changes and for the adapter to look at them. */
async function settle(adapter: FsAdapter): Promise<void> {
  // Twice: a look at a new folder can make the watcher add a watch and hear more.
  for (let i = 0; i < 2; i++) {
    await sleep(150);
    await adapter.flushEvents();
  }
}

// Linux disks are case-sensitive and keep names byte for byte, so a name
// written in NFD stays NFD: the contract's NFD cases run here. The
// case-insensitive branch needs a macOS or Windows disk.
describeAdapterContract(
  'FsAdapter (a temporary folder)',
  async () => {
    const root = await tempDir();
    const adapter = await FsAdapter.create(root);
    return { adapter, outside: (path, data) => put(root, path, data), settle: () => settle(adapter) };
  },
  { caseInsensitive: false, nfdOnDisk: true },
);

describe('FsAdapter on a real disk', () => {
  async function watched(o: { trash?: boolean } = {}) {
    const root = await tempDir();
    const adapter = await FsAdapter.create(root, o);
    const events: AdapterEvent[] = [];
    const off = adapter.watch((e) => events.push(e));
    await settle(adapter);
    return { root, adapter, events, off };
  }

  it('reports other programs\' creates, edits and deletes, in folders it has not seen before too', async () => {
    const { root, adapter, events, off } = await watched();
    await put(root, 'a.md', 'one');
    await settle(adapter);
    // Another program's write may be seen half-way (created empty, then filled): a create, then maybe a modify.
    expect(events[0]).toEqual({ type: 'create', path: 'a.md' });
    expect(events.slice(1).every((e) => e.type === 'modify' && e.path === 'a.md')).toBe(true);
    await sleep(20); // a later mtime
    await put(root, 'a.md', 'one two');
    await settle(adapter);
    expect(events.at(-1)).toEqual({ type: 'modify', path: 'a.md' });
    await put(root, 'new/deep/b.md', 'b');
    await settle(adapter);
    expect(events).toContainEqual({ type: 'create', path: 'new/deep/b.md' });
    await rm(join(root, 'a.md'));
    await settle(adapter);
    expect(events.at(-1)).toEqual({ type: 'delete', path: 'a.md' });
    off();
  });

  it('reports a folder moved away or in as the files in it', async () => {
    const { root, adapter, events, off } = await watched();
    await put(root, 'dir/x.md', 'x');
    await put(root, 'dir/sub/y.md', 'y');
    await settle(adapter);
    events.length = 0;
    await rename(join(root, 'dir'), join(root, 'moved'));
    await settle(adapter);
    expect(events).toEqual(expect.arrayContaining([
      { type: 'delete', path: 'dir/x.md' }, { type: 'delete', path: 'dir/sub/y.md' },
      { type: 'create', path: 'moved/x.md' }, { type: 'create', path: 'moved/sub/y.md' },
    ]));
    events.length = 0;
    await rm(join(root, 'moved'), { recursive: true });
    await settle(adapter);
    expect(events).toEqual(expect.arrayContaining([{ type: 'delete', path: 'moved/x.md' }, { type: 'delete', path: 'moved/sub/y.md' }]));
    off();
  });

  it('reports its own changes once, never again as another program\'s', async () => {
    const { adapter, events, off } = await watched();
    await adapter.write('a.md', bytes('1'));
    await adapter.write('a.md', bytes('22'));
    await adapter.rename('a.md', 'dir/b.md');
    await adapter.remove('dir/b.md');
    await settle(adapter);
    expect(events).toEqual([
      { type: 'create', path: 'a.md' }, { type: 'modify', path: 'a.md' },
      { type: 'rename', path: 'dir/b.md', oldPath: 'a.md' }, { type: 'delete', path: 'dir/b.md' },
    ]);
    off();
  });

  it('moves deleted files to .trash, which it neither lists nor reports', async () => {
    const { root, adapter, events, off } = await watched();
    await adapter.write('n/a.md', bytes('first'));
    await adapter.remove('n/a.md');
    await adapter.write('n/a.md', bytes('second'));
    await adapter.remove('n/a.md');
    await settle(adapter);
    expect(await readFile(join(root, '.trash/n/a.md'), 'utf8')).toBe('first');
    expect(await readFile(join(root, '.trash/n/a 1.md'), 'utf8')).toBe('second');
    expect(await adapter.list()).toEqual([]);
    expect(events.filter((e) => e.path.startsWith('.trash'))).toEqual([]);
    off();
  });

  it('deletes for good with the trash off, and then lists .trash like any folder', async () => {
    const root = await tempDir();
    const adapter = await FsAdapter.create(root, { trash: false });
    await put(root, '.trash/old.md', 'o');
    await adapter.write('a.md', bytes('a'));
    expect(await adapter.remove('a.md')).toBe(true);
    expect(await readdir(root)).toEqual(['.trash']);
    expect(await adapter.list()).toEqual(['.trash/old.md']);
  });

  it('writes whole files only, keeps the mode of the file it replaces, and leaves no temporary files', async () => {
    const root = await tempDir();
    const adapter = await FsAdapter.create(root);
    await put(root, 'secret.md', 'x');
    await chmod(join(root, 'secret.md'), 0o600);
    expect(await adapter.write('secret.md', bytes('new'))).toBe(true);
    expect((await stat(join(root, 'secret.md'))).mode & 0o777).toBe(0o600);
    expect(await readdir(root)).toEqual(['secret.md']);
    // A temporary file left by a crash is neither listed nor taken for a folder's content.
    await put(root, 'empty/.obsync-0123456789abcdef.tmp', 'partial');
    expect(TEMP_PATTERN.test('.obsync-0123456789abcdef.tmp')).toBe(true);
    expect(await adapter.list()).toEqual(['secret.md']);
    expect(await adapter.hasFolder('empty')).toBe(false);
  });

  it('never follows symbolic links: a link to a file is listed but refused, a linked folder is not entered, a path through one is refused', async () => {
    const root = await tempDir();
    const outside = await tempDir();
    await put(outside, 'private.md', 'not yours');
    const adapter = await FsAdapter.create(root);
    await symlink(outside, join(root, 'linked'));
    await symlink(join(outside, 'private.md'), join(root, 'file-link.md'));
    await put(root, 'real/a.md', 'a');
    await symlink(join(root, 'real'), join(root, 'alias'));
    // Listed, so the engine does not take it for deleted; it then fails as a file (FILE_FAILED) instead of syncing.
    expect(await adapter.list()).toEqual(['file-link.md', 'real/a.md']);
    await expect(adapter.stat('file-link.md')).rejects.toThrow(/symbolic link/);
    await expect(adapter.read('file-link.md')).rejects.toThrow(/symbolic link/);
    await expect(adapter.write('file-link.md', bytes('x'))).rejects.toThrow(/symbolic link/);
    await expect(adapter.remove('file-link.md')).rejects.toThrow(/symbolic link/);
    await expect(adapter.read('linked/private.md')).rejects.toThrow(/symbolic link/);
    await expect(adapter.write('linked/new.md', bytes('x'))).rejects.toThrow(/symbolic link/);
    await expect(adapter.write('alias/a.md', bytes('x'))).rejects.toThrow(/symbolic link/);
    expect(await readFile(join(outside, 'private.md'), 'utf8')).toBe('not yours');
    expect(await readdir(outside)).toEqual(['private.md']);
    expect((await lstat(join(root, 'file-link.md'))).isSymbolicLink()).toBe(true);
  });

  it('reports a note replaced by a link as there, not deleted', async () => {
    const { root, adapter, events, off } = await watched();
    await adapter.write('g.md', bytes('note'));
    const outside = await tempDir();
    await put(outside, 'g.md', 'elsewhere');
    await rm(join(root, 'g.md'));
    await symlink(join(outside, 'g.md'), join(root, 'g.md'));
    await settle(adapter);
    // The watcher may see the gap between the two steps (a delete, then a create), but what the
    // engine finds when it looks is a file it cannot sync, never a deletion to push.
    expect(events.at(-1)).toMatchObject({ path: 'g.md' });
    expect(events.at(-1)!.type).not.toBe('delete');
    expect(await adapter.list()).toEqual(['g.md']);
    await expect(adapter.stat('g.md')).rejects.toThrow(/symbolic link/);
    off();
  });

  it('refuses paths that are not inside the vault', async () => {
    const parent = await tempDir();
    const root = join(parent, 'vault');
    await mkdir(root);
    await put(parent, 'secret.md', 'outside');
    const adapter = await FsAdapter.create(root);
    for (const p of ['../secret.md', 'a/../../secret.md', './x.md', 'a//b.md', '/etc/passwd']) {
      await expect(adapter.read(p)).rejects.toThrow(/not a path inside the vault/);
      await expect(adapter.stat(p)).rejects.toThrow(/not a path inside the vault/);
      await expect(adapter.write(p, bytes('x'))).rejects.toThrow(/not a path inside the vault/);
    }
    await expect(adapter.rename('a.md', '../out.md')).resolves.toBe(false); // no a.md
    await adapter.write('a.md', bytes('a'));
    await expect(adapter.rename('a.md', '../out.md')).rejects.toThrow(/not a path inside the vault/);
    expect(await readdir(parent)).toEqual(['secret.md', 'vault']);
  });

  it('does not let a .trash that links elsewhere carry deleted files out of the vault', async () => {
    const root = await tempDir();
    const outside = await tempDir();
    await symlink(outside, join(root, '.trash'));
    const adapter = await FsAdapter.create(root);
    await adapter.write('note.md', bytes('keep me'));
    await expect(adapter.remove('note.md')).rejects.toThrow(/symbolic link/);
    expect(await readFile(join(root, 'note.md'), 'utf8')).toBe('keep me');
    expect(await readdir(outside)).toEqual([]);
  });

  it('does not replace a folder holding only links', async () => {
    const root = await tempDir();
    const adapter = await FsAdapter.create(root);
    await mkdir(join(root, 'linkdir'));
    await symlink('/nonexistent', join(root, 'linkdir', 'l'));
    await expect(adapter.write('linkdir', bytes('x'))).rejects.toThrow();
    expect((await lstat(join(root, 'linkdir', 'l'))).isSymbolicLink()).toBe(true);
  });

  it('lists a name stored in both NFC and NFD once', async () => {
    const root = await tempDir();
    const adapter = await FsAdapter.create(root);
    await put(root, 'café.md'.normalize('NFC'), 'nfc');
    await put(root, 'café.md'.normalize('NFD'), 'nfd');
    expect(await adapter.list()).toEqual(['café.md'.normalize('NFC')]);
  });

  it('removes temporary files left by a crash once they are old, and only those', async () => {
    const root = await tempDir();
    const adapter = await FsAdapter.create(root);
    await put(root, 'd/.obsync-00000000000000aa.tmp', 'old');
    await put(root, 'd/.obsync-00000000000000bb.tmp', 'in flight');
    const old = new Date(Date.now() - 2 * 60 * 60_000);
    await utimes(join(root, 'd/.obsync-00000000000000aa.tmp'), old, old);
    expect(await adapter.list()).toEqual([]);
    expect(await readdir(join(root, 'd'))).toEqual(['.obsync-00000000000000bb.tmp']);
  });

  it('does not report changes in folders it is told not to watch, but still lists them', async () => {
    const root = await tempDir();
    const adapter = await FsAdapter.create(root, { unwatched: (f) => f === '.git' });
    const events: AdapterEvent[] = [];
    const off = adapter.watch((e) => events.push(e));
    await settle(adapter);
    await put(root, '.git/objects/ab', 'g');
    await put(root, 'note.md', 'n');
    await settle(adapter);
    expect(events.map((e) => e.path)).not.toContain('.git/objects/ab');
    expect(events).toContainEqual({ type: 'create', path: 'note.md' });
    expect(await adapter.list()).toEqual(['.git/objects/ab', 'note.md']);
    off();
  });

  it('stays fast when many files are deleted behind its back', async () => {
    const { root, adapter, events, off } = await watched();
    for (let i = 0; i < 2000; i++) await put(root, `many/${i}.md`, 'x');
    await settle(adapter);
    events.length = 0;
    const started = Date.now();
    for (let i = 0; i < 2000; i++) await rm(join(root, `many/${i}.md`));
    await settle(adapter);
    expect(events.filter((e) => e.type === 'delete')).toHaveLength(2000);
    expect(Date.now() - started).toBeLessThan(10_000);
    off();
  });

  it('takes nothing for deleted once the vault folder is another one (a disk unmounted under it)', async () => {
    const parent = await tempDir();
    const root = join(parent, 'vault');
    await put(root, 'a.md', 'a');
    await put(root, 'dir/b.md', 'b');
    const errors: Error[] = [];
    const adapter = await FsAdapter.create(root, { onWatchError: (e) => errors.push(e) });
    const events: AdapterEvent[] = [];
    const off = adapter.watch((e) => events.push(e));
    await settle(adapter);
    // Unmounted: an empty folder of the same name is left where the vault was.
    await rename(root, join(parent, 'mounted-elsewhere'));
    await mkdir(root);
    await settle(adapter);
    expect(events.filter((e) => e.type === 'delete')).toEqual([]);
    expect(errors.some((e) => /another folder now/.test(e.message))).toBe(true);
    await expect(adapter.list()).rejects.toThrow(/another folder now/);
    await expect(adapter.stat('a.md')).rejects.toThrow(/another folder now/);
    await expect(adapter.read('a.md')).rejects.toThrow(/another folder now/);
    off();
  });

  it('opens a vault through a link to it', async () => {
    const real = await tempDir();
    const parent = await tempDir();
    await symlink(real, join(parent, 'vault'));
    const adapter = await FsAdapter.create(join(parent, 'vault'));
    expect(await adapter.write('a/b.md', bytes('x'))).toBe(true);
    expect(await readFile(join(real, 'a/b.md'), 'utf8')).toBe('x');
  });
});
