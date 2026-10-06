import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { CONFLICT_COPY_PATTERN } from '../../src/util/path';
import { makeClient, settle, type SimClient } from '../helpers/client';
import { files, newUser, remoteCommit, text } from '../helpers/fixture';
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
});
