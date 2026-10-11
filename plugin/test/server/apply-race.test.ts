// A local edit made while a remote version is being applied (between the
// apply's read of the local file and its write), against the real server.
// With whole-second mtimes the edit keeps the file's size and mtime, so the
// write precondition alone cannot see it.
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { pull } from '../../src/sync/pull';
import { PushMemory, pushRound } from '../../src/sync/push';
import { files, newDevice, newUser, text, type Device } from '../helpers/fixture';
import { startServer, type TestServer } from '../helpers/server';

let srv: TestServer;
beforeAll(async () => {
  srv = await startServer(inject('obsyncBin'));
});
afterAll(() => srv?.stop());

async function push(d: Device, path: string, content: string): Promise<void> {
  await d.adapter.write(path, text(content));
  await d.state.markDirty(path);
  await pushRound(d.ctx, new PushMemory());
}

/** The next read of path returns what is there, then the user saves edit (same size, same second) without an event reaching anyone. */
function editAfterNextRead(d: Device, path: string, edit: string): () => boolean {
  const read = d.adapter.read.bind(d.adapter);
  let done = false;
  d.adapter.read = async (p) => {
    const data = await read(p);
    if (p === path && !done) {
      done = true;
      d.adapter.writeSilently(path, text(edit));
    }
    return data;
  };
  return () => done;
}

describe.each([
  { mtimes: 'millisecond', coarseMtime: false },
  { mtimes: 'whole-second', coarseMtime: true },
])('apply with $mtimes mtimes', ({ coarseMtime }) => {
  it('never overwrites an edit made between reading the local file and writing the remote version', async () => {
    const user = await newUser(srv);
    const a = await newDevice(srv, user, { name: 'A', vault: 'create' });
    const b = await newDevice(srv, user, { name: 'B', vault: a.vaultId, coarseMtime });
    await push(a, 'x.md', 'aaaa\n');
    await pull(b.ctx);
    expect(files(b.adapter)).toEqual({ 'x.md': 'aaaa\n' });

    await push(a, 'x.md', 'bbbb\n');
    const edited = editAfterNextRead(b, 'x.md', 'cccc\n');
    await pull(b.ctx);
    expect(edited()).toBe(true);

    // The edit is kept and the remote version saved beside it, as for any conflict.
    const conflict = b.events.find((e) => e.type === 'conflict');
    expect(conflict).toMatchObject({ path: 'x.md' });
    const copy = (conflict as { conflictPath: string }).conflictPath;
    expect(files(b.adapter)).toEqual({ 'x.md': 'cccc\n', [copy]: 'bbbb\n' });

    await pushRound(b.ctx, new PushMemory());
    await pull(a.ctx);
    expect(files(a.adapter)).toEqual({ 'x.md': 'cccc\n', [copy]: 'bbbb\n' });
  });
});
