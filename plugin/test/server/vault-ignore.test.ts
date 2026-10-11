// The vault's .obsyncignore: synced like any file, its rules apply on every
// device, a new device applies it before anything else arrives.
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { makeClient, settle } from '../helpers/client';
import { files, newUser, text, type User } from '../helpers/fixture';
import { startServer, type TestServer } from '../helpers/server';

let srv: TestServer;
beforeAll(async () => {
  srv = await startServer(inject('obsyncBin'));
});
afterAll(() => srv?.stop());

const IGNORE = '.obsyncignore';

async function laptop(user: User) {
  return makeClient(srv, user, { name: 'Laptop', vault: 'create' });
}

describe('the vault ignore file', () => {
  it('keeps a new device from writing what it ignores, applying it before the first page', async () => {
    const user = await newUser(srv);
    const a = await laptop(user);
    await a.adapter.write('big/x.md', text('generated\n'));
    await a.adapter.write('notes/n.md', text('note\n'));
    await settle([a]);
    await a.adapter.write(IGNORE, text('# generated data\nbig/\n'));
    await settle([a]);

    const b = await makeClient(srv, user, { name: 'Phone', vault: a.vaultId });
    const written: string[] = [];
    b.adapter.watch((ev) => written.push(ev.path));
    await settle([a, b]);
    expect(files(b.adapter)).toEqual({ [IGNORE]: '# generated data\nbig/\n', 'notes/n.md': 'note\n' });
    expect(written[0]).toBe(IGNORE);
    const [rec] = await b.state.filesByPath('big/x.md');
    expect(rec?.ignored).toBe(true);
    // The file was looked up before the first page of changes.
    const paths = b.net.log.map((r) => r.path);
    const history = paths.findIndex((p) => p.endsWith('/history'));
    expect(history).toBeGreaterThanOrEqual(0);
    expect(history).toBeLessThan(paths.findIndex((p) => p.endsWith('/changes')));
    // The server keeps the file; a device without the rule still has it.
    expect(files(a.adapter)['big/x.md']).toBe('generated\n');
  });

  it('applies a new version of the file before the rest of the same page', async () => {
    const user = await newUser(srv);
    const a = await laptop(user);
    const b = await makeClient(srv, user, { name: 'Phone', vault: a.vaultId });
    await settle([a, b]);
    // One page for b: big/y.md first, then the rule that ignores it.
    await a.adapter.write('big/y.md', text('generated\n'));
    await a.engine.runCycle();
    await a.adapter.write(IGNORE, text('big/\n'));
    await a.engine.runCycle();
    await b.engine.runCycle();
    expect(files(b.adapter)).toEqual({ [IGNORE]: 'big/\n' });
    expect((await b.state.filesByPath('big/y.md'))[0]?.ignored).toBe(true);
  });

  it('writes the files again once the rule is removed', async () => {
    const user = await newUser(srv);
    const a = await laptop(user);
    await a.adapter.write('big/x.md', text('generated\n'));
    await a.adapter.write(IGNORE, text('big/\n'));
    await settle([a]);
    const b = await makeClient(srv, user, { name: 'Phone', vault: a.vaultId });
    await settle([a, b]);
    expect(files(b.adapter)['big/x.md']).toBeUndefined();
    await a.adapter.write(IGNORE, text('# nothing ignored\n'));
    await settle([a, b]);
    expect(files(b.adapter)['big/x.md']).toBe('generated\n');
    expect((await b.state.filesByPath('big/x.md'))[0]?.ignored).toBeFalsy();
  });

  it('pushes a file only once no rule of the vault file matches it any more', async () => {
    const user = await newUser(srv);
    const a = await laptop(user);
    const b = await makeClient(srv, user, { name: 'Phone', vault: a.vaultId });
    await b.adapter.write(IGNORE, text('drafts/\n'));
    await settle([a, b]);
    await a.adapter.write('drafts/d.md', text('draft\n'));
    await settle([a, b]);
    expect(files(b.adapter)['drafts/d.md']).toBeUndefined();
    expect((await a.api.heads(a.vaultId, null)).heads).toHaveLength(1); // only the ignore file
    await b.adapter.write(IGNORE, text(''));
    await settle([a, b]);
    expect(files(b.adapter)['drafts/d.md']).toBe('draft\n');
  });

  it('skips an unsupported line, keeps syncing, and tells the user once per change', async () => {
    const user = await newUser(srv);
    const a = await laptop(user);
    await a.adapter.write('big/x.md', text('generated\n'));
    await a.adapter.write('keep.md', text('kept\n'));
    await a.adapter.write(IGNORE, text('big/\n!keep.md\n'));
    await settle([a]);
    const b = await makeClient(srv, user, { name: 'Phone', vault: a.vaultId });
    await settle([a, b]);
    expect(files(b.adapter)).toEqual({ [IGNORE]: 'big/\n!keep.md\n', 'keep.md': 'kept\n' });
    expect(b.engine.vaultIgnoreFile.rejected).toEqual([{ line: 2, pattern: '!keep.md', why: 'negation ("!") is not supported' }]);
    const skipped = () => b.events.filter((e) => e.type === 'notice' && e.code === 'IGNORE_LINES_SKIPPED');
    expect(skipped()).toEqual([expect.objectContaining({ count: 1, path: IGNORE })]);
    await b.restart();
    await settle([a, b]);
    expect(skipped()).toHaveLength(1); // the same file: not again
    await a.adapter.write(IGNORE, text('big/\n!keep.md\n[x].md\n'));
    await settle([a, b]);
    expect(skipped()).toHaveLength(2);
    expect(skipped()[1]).toMatchObject({ count: 2 });
  });

  it('keeps syncing the file itself whatever it says', async () => {
    const user = await newUser(srv);
    const a = await laptop(user);
    const b = await makeClient(srv, user, { name: 'Phone', vault: a.vaultId });
    await a.adapter.write('n.md', text('one\n'));
    await a.adapter.write(IGNORE, text('*\n'));
    await settle([a, b]);
    expect(files(b.adapter)).toEqual({ [IGNORE]: '*\n' });
    await b.adapter.write(IGNORE, text('.*\n'));
    await settle([a, b]);
    expect(files(a.adapter)[IGNORE]).toBe('.*\n');
    expect(files(b.adapter)['n.md']).toBe('one\n'); // '.*' no longer matches n.md
  });
});
