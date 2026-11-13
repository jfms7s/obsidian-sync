// A device that syncs only some folders (the CLI's --only): nothing outside
// them arrives, leaves, or is deleted on its account, on either side.
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { makeClient, settle } from '../helpers/client';
import { files, newUser, text, type User } from '../helpers/fixture';
import { startServer, type TestServer } from '../helpers/server';
import { ONLY_MARKER_FILE } from '../../src/vault/ignore';

let srv: TestServer;
beforeAll(async () => {
  srv = await startServer(inject('obsyncBin'));
});
afterAll(() => srv?.stop());

async function devices(user: User) {
  const a = await makeClient(srv, user, { name: 'Laptop', vault: 'create' });
  const b = await makeClient(srv, user, { name: 'Pod', vault: a.vaultId, onlyFolders: ['mimir/', 'people/'] });
  return { a, b };
}

describe('a device that syncs only some folders', () => {
  it('downloads only the listed folders', async () => {
    const { a, b } = await devices(await newUser(srv));
    await a.adapter.write('mimir/a.md', text('a\n'));
    await a.adapter.write('people/p.md', text('p\n'));
    await a.adapter.write('work/secret.md', text('secret\n'));
    await a.adapter.write('top.md', text('top\n'));
    await settle([a, b]);
    expect(Object.keys(files(b.adapter)).sort()).toEqual(['mimir/a.md', 'people/p.md']);
  });

  it('uploads only the listed folders', async () => {
    const { a, b } = await devices(await newUser(srv));
    await b.adapter.write('mimir/new.md', text('new\n'));
    await b.adapter.write('work/local.md', text('local\n'));
    await settle([a, b]);
    expect(files(a.adapter)['mimir/new.md']).toBe('new\n');
    expect(files(a.adapter)['work/local.md']).toBeUndefined();
    // Paths are encrypted, so count commits: an outside file alone makes none.
    const commits = b.net.count('POST', '/commit');
    await b.adapter.write('work/local.md', text('local, edited\n'));
    await settle([a, b]);
    expect(b.net.count('POST', '/commit')).toBe(commits);
  });

  it('does not push the deletion of an outside file', async () => {
    const { a, b } = await devices(await newUser(srv));
    await a.adapter.write('work/secret.md', text('laptop\n'));
    await b.adapter.write('work/secret.md', text('pod\n')); // before b's first sync
    await settle([a, b]);
    await b.adapter.remove('work/secret.md');
    await settle([a, b]);
    expect(files(a.adapter)['work/secret.md']).toBe('laptop\n');
  });

  it('deletes an outside file on no device when it is deleted elsewhere', async () => {
    const { a, b } = await devices(await newUser(srv));
    await a.adapter.write('work/secret.md', text('laptop\n'));
    await b.adapter.write('work/secret.md', text('pod\n'));
    await settle([a, b]);
    await a.adapter.remove('work/secret.md');
    await settle([a, b]);
    expect(files(a.adapter)['work/secret.md']).toBeUndefined();
    expect(files(b.adapter)['work/secret.md']).toBe('pod\n');
  });

  it('never syncs the marker file', async () => {
    const { a, b } = await devices(await newUser(srv));
    await b.adapter.write(ONLY_MARKER_FILE, text('mimir/\npeople/\n'));
    await settle([a, b]);
    expect(files(a.adapter)[ONLY_MARKER_FILE]).toBeUndefined();
  });
});
