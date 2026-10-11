// Restoring many deleted files at once from the trash view (HistoryController.restoreMany), against the real server.
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createEngineLock } from '../../src/shell/engine-lock';
import { ShellController } from '../../src/shell/controller';
import { groupTrash } from '../../src/shell/history-controller';
import { makeClient, settle } from '../helpers/client';
import { files, newDevice, newUser, text, type Device } from '../helpers/fixture';
import { startServer, type TestServer } from '../helpers/server';

let srv: TestServer;
beforeAll(async () => {
  srv = await startServer(inject('obsyncBin'));
});
afterAll(() => srv?.stop());

function controllerFor(dev: Device): ShellController {
  return new ShellController({
    state: dev.state, adapter: dev.adapter, configDir: '.obsidian', fetch: dev.net.fetch, webSocket: null, autoRun: false,
    lock: createEngineLock(`trash-${Math.random()}`, { locks: null, registry: new Map() }), clock: dev.clock, random: dev.random,
  });
}

async function setup() {
  const user = await newUser(srv);
  const dev = await newDevice(srv, user, { name: 'Laptop', vault: 'create' });
  const phone = await makeClient(srv, user, { name: 'Phone', vault: dev.vaultId });
  const c = controllerFor(dev);
  await c.start();
  const sync = async () => {
    await c.engine!.runCycle();
    await settle([phone]);
    await c.engine!.runCycle();
  };
  return { dev, phone, c, history: c.history()!, sync };
}

describe('bulk restore from the trash', () => {
  it('restores one device\'s deletion in one go, here and, after syncing, on the other devices', async () => {
    const { dev, phone, c, history, sync } = await setup();
    for (const p of ['notes/a.md', 'notes/b.md', 'notes/c.md', 'keep.md']) await dev.adapter.write(p, text(`${p}\n`));
    await sync();
    for (const p of ['notes/a.md', 'notes/b.md', 'notes/c.md']) await phone.adapter.remove(p);
    await sync();
    await dev.adapter.remove('keep.md');
    await sync();
    expect(files(dev.adapter)).toEqual({});

    const groups = groupTrash(await history.trash());
    expect(groups.map((g) => [g.device, g.items.map((i) => i.path).sort()])).toEqual([
      ['Laptop', ['keep.md']],
      ['Phone', ['notes/a.md', 'notes/b.md', 'notes/c.md']],
    ]);
    const r = await history.restoreMany(groups[1]!.items);
    expect(r.restored.sort()).toEqual(['notes/a.md', 'notes/b.md', 'notes/c.md']);
    expect(r).toMatchObject({ skipped: [], stopped: null });
    await sync();
    const back = { 'notes/a.md': 'notes/a.md\n', 'notes/b.md': 'notes/b.md\n', 'notes/c.md': 'notes/c.md\n' };
    expect(files(dev.adapter)).toEqual(back);
    expect(files(phone.adapter)).toEqual(back);
    expect((await history.trash()).map((i) => i.path)).toEqual(['keep.md']);
    await c.stop();
  });

  it('skips and reports what cannot be restored, and restores the rest', async () => {
    const { dev, phone, c, history, sync } = await setup();
    for (const p of ['x.md', 'y.md', 'z.md']) await dev.adapter.write(p, text(`${p}\n`));
    await sync();
    for (const p of ['x.md', 'y.md', 'z.md']) await dev.adapter.remove(p);
    await sync();
    const stale = await history.trash(); // the list the view is showing
    await phone.adapter.write('x.md', text('x again\n')); // exists again
    await sync();
    await dev.adapter.write('y.md/inside.md', text('a folder took the name\n')); // the name is taken here
    const r = await history.restoreMany(stale);
    expect(r.restored).toEqual(['z.md']);
    expect(r.stopped).toBeNull();
    expect(r.skipped.map((s) => s.path).sort()).toEqual(['x.md', 'y.md']);
    expect(r.skipped.find((s) => s.path === 'x.md')!.reason).toMatch(/exists again/);
    expect(r.skipped.find((s) => s.path === 'y.md')!.reason).toMatch(/y\.md\//);
    expect(files(dev.adapter)['z.md']).toBe('z.md\n');
    await c.stop();
  });

  it('stops when the server cannot be reached and says how far it got', async () => {
    const { dev, c, history, sync } = await setup();
    for (const p of ['a.md', 'b.md']) await dev.adapter.write(p, text(`${p}\n`));
    await sync();
    for (const p of ['a.md', 'b.md']) await dev.adapter.remove(p);
    await sync();
    const items = await history.trash();
    dev.net.online = false;
    const r = await history.restoreMany(items);
    expect(r.restored).toEqual([]);
    expect(r.skipped).toEqual([]);
    expect(r.stopped).toMatch(/Cannot reach the server/);
    dev.net.online = true;
    await c.stop();
  });
});
