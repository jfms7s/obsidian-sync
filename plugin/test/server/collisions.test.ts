import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { fileIdFor } from '../../src/crypto/objects';
import { equalBytes } from '../../src/util/bytes';
import { CONFLICT_COPY_PATTERN } from '../../src/util/path';
import { makeClient, settle, type SimClient } from '../helpers/client';
import { files, nameKeepingCollision, newUser, remoteCommit, text } from '../helpers/fixture';
import { startServer, type TestServer } from '../helpers/server';

let srv: TestServer;
beforeAll(async () => {
  srv = await startServer(inject('obsyncBin'));
});
afterAll(() => srv?.stop());

async function trio(): Promise<[SimClient, SimClient, SimClient]> {
  const user = await newUser(srv);
  const a = await makeClient(srv, user, { name: 'Laptop', vault: 'create' });
  const b = await makeClient(srv, user, { name: 'Phone', vault: a.vaultId });
  const c = await makeClient(srv, user, { name: 'Tablet', vault: a.vaultId });
  return [a, b, c];
}

const copies = (c: SimClient) => Object.keys(files(c.adapter)).filter((p) => CONFLICT_COPY_PATTERN.test(p));

describe('a file and a folder wanting the same path', () => {
  it('saves an incoming file beside a local folder, under a name taken from the version', async () => {
    const [a, b] = await trio();
    await a.adapter.write('docs/x.md', text('inside\n'));
    await a.engine.runCycle();
    await remoteCommit(a, 'docs', text('the file\n'), 'Remote');
    await b.engine.runCycle();
    await a.engine.runCycle();
    // Times in copy names are UTC so every device derives the same name; mtimeMs of remoteCommit is 1.
    const copy = 'docs (conflict Remote 1970-01-01 0000)';
    expect(files(a.adapter)).toEqual({ 'docs/x.md': 'inside\n', [copy]: 'the file\n' });
    const notice = a.events.find((e) => e.type === 'notice' && e.code === 'PATH_COLLISION');
    expect(notice).toMatchObject({ path: 'docs', conflictPath: copy, persistent: false });
  });

  it('converges on exactly one copy when three devices meet the collision', async () => {
    const [a, b, c] = await trio();
    // Laptop makes a file "docs" while Phone, offline from it, makes a folder "docs".
    await a.adapter.write('docs', text('from laptop\n'));
    await b.adapter.write('docs/x.md', text('from phone\n'));
    await a.engine.runCycle();
    await b.engine.runCycle();
    await settle([a, b, c]);
    const names = Object.keys(files(a.adapter)).sort();
    expect(names).toHaveLength(2);
    expect(names).toContain('docs/x.md');
    expect(copies(a)).toHaveLength(1);
    const expected = files(a.adapter);
    expect(expected[copies(a)[0]!]).toBe('from laptop\n');
    expect(files(b.adapter)).toEqual(expected);
    expect(files(c.adapter)).toEqual(expected);
  });

  it('moves a local file that stands where a remote folder needs to be, edits included', async () => {
    const [a, b] = await trio();
    await a.adapter.write('plan', text('v1\n'));
    await settle([a, b]);
    await a.adapter.write('plan', text('v1\nunsynced edit\n')); // never pushed
    await remoteCommit(b, 'plan/step.md', text('a step\n'), 'Remote');
    await a.engine.runCycle();
    const names = Object.keys(files(a.adapter)).sort();
    expect(names).toHaveLength(2);
    expect(files(a.adapter)['plan/step.md']).toBe('a step\n');
    expect(files(a.adapter)[copies(a)[0]!]).toBe('v1\nunsynced edit\n');
    expect(a.events.some((e) => e.type === 'notice' && e.code === 'PATH_COLLISION')).toBe(true);
    await settle([a, b]);
    expect(files(b.adapter)).toEqual(files(a.adapter));
  });

  it('applies a shadowed file as soon as the folder is gone', async () => {
    const [a, b] = await trio();
    await a.adapter.write('docs/x.md', text('inside\n'));
    await settle([a, b]);
    await remoteCommit(a, 'docs', text('the file\n'), 'Remote');
    await a.engine.runCycle();
    expect(files(a.adapter)['docs']).toBeUndefined();
    await a.adapter.remove('docs/x.md');
    await a.engine.runCycle();
    expect(files(a.adapter)['docs']).toBe('the file\n');
  });

  it('deletes the file again when a server restore brings it back over a folder (convergence seed 519)', async () => {
    // Laptop makes a file "docs" while Phone, not yet pulled, makes a folder "docs".
    const [a, b, c] = await trio();
    await a.adapter.write('docs', text('from laptop\n'));
    await a.engine.runCycle();
    await b.adapter.write('docs/x.md', text('from phone\n'));
    await b.engine.runCycle(); // the file is saved beside the folder here and stays live on the server
    const backup = await srv.snapshot();
    await settle([a, b, c]); // the laptop moves its file beside the folder and deletes "docs"
    const settled = files(a.adapter);
    expect(Object.keys(settled).sort()).toEqual([copies(a)[0]!, 'docs/x.md'].sort());
    // The restore brings the file "docs" back, but every device holds the folder now.
    await srv.restore(backup);
    await settle([a, b, c]);
    for (const d of [a, b, c]) expect(files(d.adapter)).toEqual(settled);
    // The server agrees: "docs" is not a live file next to the folder.
    const docsId = await fileIdFor(a.ring.namingKey, 'docs');
    const head = (await a.api.heads(a.vaultId, null)).heads.find((h) => equalBytes(h.fileId, docsId));
    expect(head?.deleted).toBe(true);
  });
});

describe('collision details', () => {
  const COPY = 'docs (conflict Remote 1970-01-01 0000)';
  const heads = (c: SimClient) => c.net.log.filter((r) => r.method === 'GET' && r.path.endsWith('/heads')).length;

  it('says a folder, not letter case, keeps a local file from syncing when a folder shadows its record', async () => {
    const [a] = await trio();
    await a.adapter.write('docs/x.md', text('inside\n'));
    await a.engine.runCycle();
    await remoteCommit(a, 'docs', text('the file\n'), 'Remote');
    await a.engine.runCycle();
    expect((await a.state.filesByPath('docs'))[0]).toMatchObject({ shadowed: true, shadowedBy: 'folder' });
    // The folder goes and a file takes its name before a reconcile re-applies the shadowed version.
    a.adapter.removeSilently('docs/x.md');
    a.adapter.writeSilently('docs', text('mine\n'));
    await a.state.markDirty('docs');
    a.events.length = 0;
    await a.engine.runCycle();
    const notice = a.events.find((e) => e.type === 'notice' && e.path === 'docs');
    expect(notice).toMatchObject({ code: 'PATH_COLLISION' });
    expect((notice as { message: string }).message).toMatch(/folder/);
    expect((notice as { message: string }).message).not.toMatch(/letter case/);
  });

  it('does not reconcile again after moving a blocking local file out of the way', async () => {
    const [a, b] = await trio();
    await a.adapter.write('other.md', text('o\n'));
    await a.engine.runCycle(); // the first cycle reconciles
    a.adapter.writeSilently('plan', text('local file\n'));
    await remoteCommit(b, 'plan/step.md', text('a step\n'), 'Remote');
    await a.engine.runCycle(); // a pull: evicts "plan"
    expect(a.events.some((e) => e.type === 'notice' && e.code === 'PATH_COLLISION')).toBe(true);
    const before = heads(a);
    await a.adapter.remove('other.md'); // a delete: a shadowed file could take a freed name, if there were one
    await a.engine.runCycle();
    expect(heads(a)).toBe(before);
  });

  it('numbers the copy when a file with other content already has its name', async () => {
    const [a] = await trio();
    await a.adapter.write('docs/x.md', text('inside\n'));
    await a.adapter.write(COPY, text('something else\n'));
    await a.engine.runCycle();
    await remoteCommit(a, 'docs', text('the file\n'), 'Remote');
    await a.engine.runCycle();
    expect(files(a.adapter)).toMatchObject({ [COPY]: 'something else\n', [`${COPY.slice(0, -1)} 2)`]: 'the file\n' });
  });

  it('numbers the copy when a folder has its name', async () => {
    const [a] = await trio();
    await a.adapter.write('docs/x.md', text('inside\n'));
    await a.adapter.write(`${COPY}/y.md`, text('a folder named like the copy\n'));
    await a.engine.runCycle();
    await remoteCommit(a, 'docs', text('the file\n'), 'Remote');
    await a.engine.runCycle();
    expect(files(a.adapter)[`${COPY.slice(0, -1)} 2)`]).toBe('the file\n');
  });

  it('moves a blocking file out of the way however deep it sits', async () => {
    const [a, b] = await trio();
    a.adapter.writeSilently('x/y', text('a file where a folder must be\n'));
    await remoteCommit(b, 'x/y/z.md', text('deep\n'), 'Remote');
    await a.engine.runCycle();
    const copy = copies(a)[0]!;
    expect(copy).toMatch(/^x\/y \(conflict Laptop /);
    expect(files(a.adapter)).toEqual({ 'x/y/z.md': 'deep\n', [copy]: 'a file where a folder must be\n' });
  });

  it('saves an incoming file beside a folder that holds only ignored files, which the disk still has', async () => {
    const [a] = await trio();
    a.adapter.writeSilently('docs/.DS_Store', text('finder\n'));
    await a.engine.runCycle();
    await remoteCommit(a, 'docs', text('the file\n'), 'Remote');
    await a.engine.runCycle();
    expect(files(a.adapter)).toEqual({ 'docs/.DS_Store': 'finder\n', [COPY]: 'the file\n' });
  });

  it('names the copy of a local file that loses a case collision after this device and the file\'s mtime', async () => {
    const user = await newUser(srv);
    const a = await makeClient(srv, user, { name: 'Laptop', vault: 'create' });
    const b = await makeClient(srv, user, { name: 'Phone', vault: a.vaultId, caseInsensitive: true });
    const winner = await nameKeepingCollision(a, 'readme.md', 'README.md');
    const loser = winner === 'readme.md' ? 'README.md' : 'readme.md';
    await b.adapter.write(loser, text('never synced\n'));
    const mtime = (await b.adapter.stat(loser))!.mtime;
    await a.adapter.write(winner, text('wins\n'));
    await a.engine.runCycle();
    await b.engine.runCycle();
    const stem = loser.slice(0, -3);
    const stamp = new Date(mtime).toISOString().replace(/^(\d{4}-\d\d-\d\d)T(\d\d):(\d\d).*$/, '$1 $2$3');
    const copy = `${stem} (conflict Phone ${stamp}).md`;
    expect(files(b.adapter)).toEqual({ [winner]: 'wins\n', [copy]: 'never synced\n' });
    expect(b.events).toContainEqual(expect.objectContaining({ type: 'notice', code: 'CASE_COLLISION', path: loser, conflictPath: copy }));
  });
});
