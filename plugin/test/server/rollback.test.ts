// A server restored from a backup, after which another device pushes the
// vault's seq past every other device's cursor (so "vault_seq < cursor"
// cannot reveal it). Newer local edits must survive and be pushed again.
import { afterAll, beforeAll, expect, inject, it } from 'vitest';
import { CONFLICT_COPY_PATTERN } from '../../src/util/path';
import { makeClient, settle } from '../helpers/client';
import { files, newUser, text } from '../helpers/fixture';
import { startServer, type TestServer } from '../helpers/server';

let srv: TestServer;
beforeAll(async () => {
  srv = await startServer(inject('obsyncBin'));
});
afterAll(() => srv?.stop());

it('notices a restored server even when the seq has moved past the cursor, and keeps newer local edits', async () => {
  const user = await newUser(srv);
  const a = await makeClient(srv, user, { name: 'Laptop', vault: 'create' });
  const b = await makeClient(srv, user, { name: 'Phone', vault: a.vaultId });
  await a.adapter.write('note.md', text('v1\n'));
  await settle([a, b]);
  const backup = await srv.snapshot();

  await a.adapter.write('note.md', text('v2 important\n'));
  await a.adapter.write('new.md', text('new\n'));
  await settle([a, b]);
  await srv.restore(backup); // the server forgets v2 and new.md

  const c = await makeClient(srv, user, { name: 'Tablet', vault: a.vaultId });
  for (const p of ['c1.md', 'c2.md', 'c3.md', 'c4.md']) await c.adapter.write(p, text(`${p}\n`));
  await settle([c]);
  expect((await c.api.changes(c.vaultId, 0)).vaultSeq).toBeGreaterThanOrEqual(await a.state.getCursor());

  // A finds out on its next pull (the version at its cursor changed);
  // B only through reconcile's heads check (its cursor anchor is cleared).
  await b.state.setCursorAnchor(null);
  await b.restart();
  await settle([a, b, c]);

  for (const d of [a, b, c]) {
    const f = files(d.adapter);
    expect(f['note.md']).toBe('v2 important\n');
    expect(f['new.md']).toBe('new\n');
    for (const p of ['c1.md', 'c2.md', 'c3.md', 'c4.md']) expect(f[p]).toBe(`${p}\n`);
  }
  expect(files(b.adapter)).toEqual(files(a.adapter));
  expect(files(c.adapter)).toEqual(files(a.adapter));
  // The restored server's v1 is kept beside it, not silently dropped.
  const copies = Object.keys(files(a.adapter)).filter((p) => CONFLICT_COPY_PATTERN.test(p));
  expect(copies.map((p) => files(a.adapter)[p])).toEqual(['v1\n']);
  expect(a.events).toContainEqual(expect.objectContaining({ type: 'notice', code: 'SERVER_ROLLBACK' }));
  expect(b.events).toContainEqual(expect.objectContaining({ type: 'notice', code: 'SERVER_ROLLBACK' }));
});

it('notices a restored server whose new commits reuse the seq of a version this device synced', async () => {
  const user = await newUser(srv);
  const a = await makeClient(srv, user, { name: 'Laptop', vault: 'create' });
  const b = await makeClient(srv, user, { name: 'Phone', vault: a.vaultId });
  await a.adapter.write('x.md', text('base\n'));
  await settle([a, b]);
  const backup = await srv.snapshot();

  await a.adapter.write('x.md', text('base\nlaptop edit\n'));
  await settle([a, b]);
  await srv.restore(backup); // forgets the laptop edit

  // Tablet edits the same file: its commit takes the seq the laptop edit had.
  const c = await makeClient(srv, user, { name: 'Tablet', vault: a.vaultId });
  await settle([c]);
  await c.adapter.write('x.md', text('base\ntablet edit\n'));
  await settle([c]);
  expect(await c.state.getCursor()).toBe(await a.state.getCursor());

  await settle([a, b, c]);
  const all = [a, b, c].map((d) => Object.values(files(d.adapter)));
  // Both edits survive on every device (one as a conflict copy), none was silently overwritten.
  for (const contents of all) expect(contents.sort()).toEqual(['base\nlaptop edit\n', 'base\ntablet edit\n']);
  expect(files(b.adapter)).toEqual(files(a.adapter));
  expect(files(c.adapter)).toEqual(files(a.adapter));
  expect(a.events).toContainEqual(expect.objectContaining({ type: 'notice', code: 'SERVER_ROLLBACK' }));
});

it('notices a restored server when a new commit takes the seq of this device\'s own, not yet pulled, commit', async () => {
  const user = await newUser(srv);
  const a = await makeClient(srv, user, { name: 'Laptop', vault: 'create' });
  const b = await makeClient(srv, user, { name: 'Phone', vault: a.vaultId });
  await a.adapter.write('base.md', text('base\n'));
  await settle([a, b]);
  const backup = await srv.snapshot();

  await a.adapter.write('mine.md', text('mine\n'));
  await a.engine.runCycle(); // pushed at seq 2; this device's cursor is still 1
  expect(await a.state.getCursor()).toBe(1);
  await srv.restore(backup); // the server forgets mine.md

  const c = await makeClient(srv, user, { name: 'Tablet', vault: a.vaultId });
  await settle([c]);
  await c.adapter.write('theirs.md', text('theirs\n')); // takes seq 2
  await settle([c]);

  await settle([a, b, c]);
  for (const d of [a, b, c]) expect(files(d.adapter)).toEqual({ 'base.md': 'base\n', 'mine.md': 'mine\n', 'theirs.md': 'theirs\n' });
  expect(a.events).toContainEqual(expect.objectContaining({ type: 'notice', code: 'SERVER_ROLLBACK' }));
});
