import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { ManualClock } from '../../src/util/clock';
import { CONFLICT_COPY_PATTERN } from '../../src/util/path';
import { makeClient, settle, type SimClient } from '../helpers/client';
import { files, newUser, text } from '../helpers/fixture';
import { startServer, type TestServer } from '../helpers/server';

let srv: TestServer;
beforeAll(async () => {
  srv = await startServer(inject('obsyncBin'));
});
afterAll(() => srv?.stop());

const copies = (c: SimClient) => Object.keys(files(c.adapter)).filter((p) => CONFLICT_COPY_PATTERN.test(p));

describe('names that differ only in letter case', () => {
  it('tells the user where the colliding file was saved', async () => {
    const user = await newUser(srv);
    const a = await makeClient(srv, user, { name: 'Laptop', vault: 'create' });
    const b = await makeClient(srv, user, { name: 'Phone', vault: a.vaultId, caseInsensitive: true });
    await b.adapter.write('readme.md', text('lower\n'));
    await a.adapter.write('README.md', text('upper\n'));
    await b.engine.runCycle();
    await settle([a, b]);
    const notice = b.events.find((e) => e.type === 'notice' && e.code === 'CASE_COLLISION');
    expect(notice).toMatchObject({ path: 'README.md', conflictPath: 'README (conflict Laptop 2026-01-02 0304).md', persistent: false });
  });

  it('saves a colliding file under one name on every case-insensitive device, whatever their clocks say', async () => {
    const user = await newUser(srv);
    const a = await makeClient(srv, user, { name: 'Laptop', vault: 'create' });
    const b = await makeClient(srv, user, { name: 'Phone', vault: a.vaultId, caseInsensitive: true });
    const c = await makeClient(srv, user, { name: 'Tablet', vault: a.vaultId, caseInsensitive: true, clock: new ManualClock(Date.UTC(2026, 5, 7, 21, 45)) });
    await a.adapter.write('README.md', text('upper\n'));
    await a.adapter.write('readme.md', text('lower\n'));
    await settle([a, b, c]);
    expect(copies(b)).toHaveLength(1);
    expect(files(b.adapter)).toEqual(files(c.adapter));
    expect(Object.values(files(b.adapter)).sort()).toEqual(['lower\n', 'upper\n']);
    // The case-sensitive device holds both names and also the saved copy.
    expect(Object.keys(files(a.adapter)).sort()).toEqual(['README.md', 'readme.md', ...copies(b)].sort());
  });

  it('keeps both names when a case-only rename meets an edit of the old name', async () => {
    const user = await newUser(srv);
    const a = await makeClient(srv, user, { name: 'Laptop', vault: 'create' });
    const b = await makeClient(srv, user, { name: 'Phone', vault: a.vaultId, caseInsensitive: true });
    await a.adapter.write('todo.md', text('- milk\n'));
    await settle([a, b]);
    await b.adapter.write('todo.md', text('- milk\n- eggs\n'));
    await a.adapter.rename('todo.md', 'TODO.md');
    await a.engine.runCycle();
    await b.engine.runCycle();
    await settle([a, b]);
    // The edit is not lost and the renamed file is not either; the case-insensitive device keeps the edit at the old name and the renamed content as a copy.
    expect(files(b.adapter)['todo.md']).toBe('- milk\n- eggs\n');
    expect(Object.entries(files(b.adapter)).filter(([p]) => CONFLICT_COPY_PATTERN.test(p)).map(([, t]) => t)).toEqual(['- milk\n']);
    expect(files(a.adapter)['todo.md']).toBe('- milk\n- eggs\n');
    expect(files(a.adapter)['TODO.md']).toBe('- milk\n');
    expect(b.events.some((e) => e.type === 'notice' && e.code === 'CASE_COLLISION' && e.conflictPath !== undefined)).toBe(true);
  });

  it('renames in place, without a copy, only while the file is unchanged here', async () => {
    const user = await newUser(srv);
    const a = await makeClient(srv, user, { name: 'Laptop', vault: 'create', caseInsensitive: true });
    const b = await makeClient(srv, user, { name: 'Phone', vault: a.vaultId, caseInsensitive: true });
    await a.adapter.write('todo.md', text('- milk\n'));
    await settle([a, b]);
    await a.adapter.rename('todo.md', 'TODO.md');
    await settle([a, b]);
    expect(files(b.adapter)).toEqual({ 'TODO.md': '- milk\n' });
    expect(b.events.some((e) => e.type === 'notice' && e.code === 'CASE_COLLISION')).toBe(false);
  });
});
