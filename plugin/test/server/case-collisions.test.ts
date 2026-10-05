import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { fileIdFor } from '../../src/crypto/objects';
import { keyringFromStored } from '../../src/services/vaults';
import { toHex } from '../../src/util/bytes';
import { ManualClock } from '../../src/util/clock';
import { CONFLICT_COPY_PATTERN } from '../../src/util/path';
import { makeClient, settle, type SimClient } from '../helpers/client';
import { files, nameKeepingCollision, newUser, text } from '../helpers/fixture';
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
    expect(notice).toMatchObject({ persistent: false });
    const conflictPath = (notice as { conflictPath?: string }).conflictPath;
    expect(conflictPath).toMatch(CONFLICT_COPY_PATTERN);
    expect(files(b.adapter)).toHaveProperty([conflictPath!]);
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
    // README.md arrived first. When it keeps the name, readme.md is only shadowed on the
    // case-insensitive devices, so the case-sensitive one holds both names and the copy.
    // When readme.md keeps it, they moved README.md away (a delete everyone gets).
    const winner = await nameKeepingCollision(a, 'README.md', 'readme.md');
    const expected = winner === 'README.md' ? ['README.md', 'readme.md', ...copies(b)] : ['readme.md', ...copies(b)];
    expect(Object.keys(files(a.adapter)).sort()).toEqual(expected.sort());
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

  it('lets the name with the lower file id keep a collision on every case-insensitive device, whoever wrote it first', async () => {
    // File ids depend on the vault's naming key, so across fresh vaults the
    // lower one is sometimes the name the second device wrote and sometimes
    // the one the first device wrote: both ways must end the same.
    const wonBy = new Set<string>();
    for (let round = 0; round < 8; round++) {
      const user = await newUser(srv);
      const a = await makeClient(srv, user, { name: 'Laptop', vault: 'create', caseInsensitive: true });
      const b = await makeClient(srv, user, { name: 'Phone', vault: a.vaultId, caseInsensitive: true });
      const c = await makeClient(srv, user, { name: 'Tablet', vault: a.vaultId, caseInsensitive: true });
      const ring = await keyringFromStored((await a.state.getVault())!);
      const ids = new Map<string, string>();
      for (const p of ['Readme.md', 'README.md']) ids.set(p, toHex(await fileIdFor(ring.namingKey, p)));
      const winner = ids.get('Readme.md')! < ids.get('README.md')! ? 'Readme.md' : 'README.md';
      const loser = winner === 'Readme.md' ? 'README.md' : 'Readme.md';
      wonBy.add(winner === 'Readme.md' ? 'laptop' : 'phone');
      await b.adapter.write('README.md', text('phone wrote this\n')); // unsynced when the laptop's file arrives
      await a.adapter.write('Readme.md', text('laptop wrote this\n'));
      await a.engine.runCycle();
      await b.engine.runCycle();
      await settle([a, b, c]);
      for (const d of [b, c]) expect(files(d.adapter)).toEqual(files(a.adapter));
      const names = Object.keys(files(a.adapter));
      expect(names).toHaveLength(2);
      expect(names).toContain(winner);
      expect(names).not.toContain(loser);
      expect(Object.values(files(a.adapter)).sort()).toEqual(['laptop wrote this\n', 'phone wrote this\n']);
    }
    expect([...wonBy].sort()).toEqual(['laptop', 'phone']);
  });
});
