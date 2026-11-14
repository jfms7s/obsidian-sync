// A device that syncs only some folders (the CLI's --only): nothing outside
// them arrives, leaves, or is deleted on its account, on either side.
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { makeClient, settle } from '../helpers/client';
import { files, newUser, text, type User } from '../helpers/fixture';
import { startServer, type TestServer } from '../helpers/server';
import { OUTSIDE_PATH_PREFIX } from '../../src/sync/apply';
import { ONLY_MARKER_FILE, VAULT_IGNORE_FILE as IGNORE } from '../../src/vault/ignore';

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

  it('keeps no outside path in its state', async () => {
    const { a, b } = await devices(await newUser(srv));
    await a.adapter.write('work/Secret Title.md', text('secret\n'));
    await a.adapter.write('mimir/a.md', text('a\n'));
    await settle([a, b]);
    const records = await b.state.allFiles();
    expect(JSON.stringify(records)).not.toContain('Secret Title');
    const outside = records.filter((r) => r.ignored && !r.path.startsWith('mimir/') && !r.path.startsWith('people/'));
    expect(outside.length).toBeGreaterThan(0);
    for (const r of outside) expect(r.path.startsWith(OUTSIDE_PATH_PREFIX)).toBe(true);
    // The placeholder counts as applied: a reconcile fetches no history for it.
    const histories = b.net.log.filter((r) => r.path.endsWith('/history')).length;
    b.engine.requestReconcile();
    await settle([a, b]);
    expect(b.net.log.filter((r) => r.path.endsWith('/history')).length).toBe(histories);
  });
});

describe('the vault ignore file on a device that syncs only some folders', () => {
  /** a's vault with an ignore file for mimir/private/, and a new device b that has settled with it. */
  async function ruled() {
    const user = await newUser(srv);
    const a = await makeClient(srv, user, { name: 'Laptop', vault: 'create' });
    await a.adapter.write('mimir/private/x.md', text('private\n'));
    await a.adapter.write('mimir/ok.md', text('ok\n'));
    await settle([a]);
    // After the files: a's own rule would keep it from pushing mimir/private/x.md.
    await a.adapter.write(IGNORE, text('mimir/private/\n'));
    await settle([a]);
    const b = await makeClient(srv, user, { name: 'Pod', vault: a.vaultId, onlyFolders: ['mimir/', 'people/'] });
    await settle([a, b]);
    return { a, b };
  }

  it('applies the vault ignore file inside the folders without writing it', async () => {
    const { b } = await ruled();
    expect(files(b.adapter)).toEqual({ 'mimir/ok.md': 'ok\n' });
  });

  it('follows a new version of the vault ignore file', async () => {
    const { a, b } = await ruled();
    expect(files(b.adapter)['mimir/private/x.md']).toBeUndefined();
    await a.adapter.write(IGNORE, text(''));
    await settle([a, b]);
    expect(files(b.adapter)['mimir/private/x.md']).toBe('private\n');
    expect(files(b.adapter)[IGNORE]).toBeUndefined();
    expect(files(a.adapter)[IGNORE]).toBe('');
  });

  it('does not push a local .obsyncignore', async () => {
    const { a, b } = await ruled();
    await b.adapter.write(IGNORE, text('*\n'));
    await a.adapter.write('mimir/ok2.md', text('ok2\n'));
    await settle([a, b]);
    expect(files(a.adapter)[IGNORE]).toBe('mimir/private/\n');
    expect(files(b.adapter)['mimir/ok2.md']).toBe('ok2\n');
  });
});
