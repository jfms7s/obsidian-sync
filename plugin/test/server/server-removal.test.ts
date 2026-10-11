// "Also remove these files from the server" after new ignore rules match
// files this device already synced (server-removal.ts), against the real server.
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { fileIdFor } from '../../src/crypto/objects';
import { createEngineLock } from '../../src/shell/engine-lock';
import { ShellController } from '../../src/shell/controller';
import { HOLD_MIN_FILES } from '../../src/sync/deletion-hold';
import { serverRemovals } from '../../src/sync/server-removal';
import { toHex } from '../../src/util/bytes';
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
    lock: createEngineLock(`removal-${dev.name}-${Math.random()}`, { locks: null, registry: new Map() }), clock: dev.clock, random: dev.random,
  });
}

/** Live (not deleted) heads on the server, by file id. */
async function liveHeads(dev: Device): Promise<number> {
  return (await dev.api.heads(dev.vaultId, null)).heads.filter((h) => !h.deleted).length;
}

async function setup() {
  const user = await newUser(srv);
  const dev = await newDevice(srv, user, { name: 'Laptop', vault: 'create' });
  const other = await makeClient(srv, user, { name: 'Phone', vault: dev.vaultId });
  const c = controllerFor(dev);
  await c.start();
  return { dev, other, c };
}

describe('removing newly ignored files from the server', () => {
  it('reports what new rules match and changes nothing on the server without a confirmation', async () => {
    const { dev, other, c } = await setup();
    await dev.adapter.write('big/a.csv', text('1,2,3\n'));
    await dev.adapter.write('big/b.csv', text('4,5\n'));
    await dev.adapter.write('notes/n.md', text('note\n'));
    await c.engine!.runCycle();
    await settle([other]);
    expect(Object.keys(files(other.adapter)).sort()).toEqual(['big/a.csv', 'big/b.csv', 'notes/n.md']);

    const newly = await c.setIgnoreGlobs(['big/']);
    expect(newly).toEqual({ paths: ['big/a.csv', 'big/b.csv'], bytes: 6 + 4 });
    await c.engine!.runCycle();
    await settle([other]);
    expect(await liveHeads(dev)).toBe(3);
    expect(Object.keys(files(other.adapter)).sort()).toEqual(['big/a.csv', 'big/b.csv', 'notes/n.md']);
    // Saving again, or rules that match nothing new, offer nothing.
    expect((await c.setIgnoreGlobs(['big/'])).paths).toEqual([]);
    expect((await c.setIgnoreGlobs(['big/', 'nothing/'])).paths).toEqual([]);
    await c.stop();
  });

  it('deletes them on the server once confirmed: other devices trash them, this device keeps them', async () => {
    const { dev, other, c } = await setup();
    await dev.adapter.write('big/a.csv', text('1,2,3\n'));
    await dev.adapter.write('notes/n.md', text('note\n'));
    await c.engine!.runCycle();
    await settle([other]);
    const newly = await c.setIgnoreGlobs(['big/']);
    await c.removeFromServer(newly.paths);
    await c.engine!.runCycle();
    expect(await liveHeads(dev)).toBe(1);
    expect(await serverRemovals(dev.state)).toEqual(new Set());
    await settle([other]);
    expect(files(other.adapter)).toEqual({ 'notes/n.md': 'note\n' });
    expect(files(dev.adapter)).toEqual({ 'big/a.csv': '1,2,3\n', 'notes/n.md': 'note\n' });
    // The server keeps the content in its deleted files.
    expect((await dev.api.trash(dev.vaultId)).length).toBe(1);

    // Removing the rule uploads this device's copy again.
    await c.setIgnoreGlobs([]);
    await c.engine!.runCycle();
    await c.engine!.runCycle();
    await settle([other]);
    expect(files(other.adapter)).toEqual({ 'big/a.csv': '1,2,3\n', 'notes/n.md': 'note\n' });
    await c.stop();
  });

  it('also removes a newer version this device never wrote, and nothing the rules no longer ignore', async () => {
    const { dev, other, c } = await setup();
    await dev.adapter.write('big/a.csv', text('1\n'));
    await dev.adapter.write('big/b.csv', text('2\n'));
    await c.engine!.runCycle();
    await settle([other]);
    const newly = await c.setIgnoreGlobs(['big/']);
    // Another device edits a.csv meanwhile: this device records it as ignored.
    await other.adapter.write('big/a.csv', text('1 changed\n'));
    await settle([other]);
    await c.engine!.runCycle();
    // The user narrows the rule before the removal is pushed: b.csv is synced again, not removed.
    await c.setIgnoreGlobs(['big/a.csv']);
    await c.removeFromServer(newly.paths);
    await c.engine!.runCycle();
    await settle([other]);
    const heads = (await dev.api.heads(dev.vaultId, null)).heads;
    expect(heads.filter((h) => h.deleted)).toHaveLength(1);
    expect(files(other.adapter)).toEqual({ 'big/b.csv': '2\n' });
    expect(files(dev.adapter)).toEqual({ 'big/a.csv': '1\n', 'big/b.csv': '2\n' });
    expect(await serverRemovals(dev.state)).toEqual(new Set());
    await c.stop();
  });

  it('commits the vault file before the removals it explains', async () => {
    const { dev, other, c } = await setup();
    await dev.adapter.write('big/a.csv', text('1\n'));
    await c.engine!.runCycle();
    await settle([other]);
    const saved = await c.setVaultIgnoreText('big/\n');
    expect(saved.newlyIgnored.paths).toEqual(['big/a.csv']);
    await c.removeFromServer(saved.newlyIgnored.paths);
    await c.engine!.runCycle();
    // The phone ignores big/ too (the rule is in the vault file): it keeps its copy.
    await settle([other]);
    expect(files(other.adapter)).toEqual({ '.obsyncignore': 'big/\n', 'big/a.csv': '1\n' });
    const changes = (await dev.api.changes(dev.vaultId, 0)).versions;
    const ignoreFileId = toHex(await fileIdFor(dev.ring.namingKey, '.obsyncignore'));
    const ruleSeq = changes.find((v) => toHex(v.fileId) === ignoreFileId)!.seq;
    const deletionSeq = changes.find((v) => v.deleted)!.seq;
    expect(ruleSeq).toBeLessThan(deletionSeq);
    expect(await liveHeads(dev)).toBe(1);
    await c.stop();
  });

  it('is not held by the mass-deletion guard: the user already confirmed it', async () => {
    const { dev, other, c } = await setup();
    for (let i = 0; i <= HOLD_MIN_FILES; i++) await dev.adapter.write(`gen/${i}.md`, text(`${i}\n`));
    await c.engine!.runCycle();
    await settle([other]);
    const newly = await c.setIgnoreGlobs(['gen/']);
    expect(newly.paths).toHaveLength(HOLD_MIN_FILES + 1);
    await c.removeFromServer(newly.paths);
    await c.engine!.runCycle();
    expect(await c.heldDeletions()).toEqual([]);
    expect(await liveHeads(dev)).toBe(0);
    await c.stop();
  });
});
