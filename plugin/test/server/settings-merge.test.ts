// Settings files from other devices (spec 2026-10-11-settings-layer-design
// D4, D6): merged by key with the remote side winning, never into conflict
// copies; a stale rewrite by Obsidian after a remote version arrived pushes
// only what changed here; one restart notice per cycle.
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { defaultSettingsSyncPolicy } from '../../src/vault/config-policy';
import { makeClient, settle, type SimClient } from '../helpers/client';
import { files, newUser } from '../helpers/fixture';
import { startServer, type TestServer } from '../helpers/server';

let srv: TestServer;
beforeAll(async () => {
  srv = await startServer(inject('obsyncBin'));
});
afterAll(() => srv?.stop());

const APP = '.obsidian/app.json';
const policy = defaultSettingsSyncPolicy(false);
const json = (o: unknown) => new TextEncoder().encode(JSON.stringify(o, null, 2));
const read = (c: SimClient, p = APP): unknown => JSON.parse(files(c.adapter)[p]!);
const configFiles = (c: SimClient) => Object.keys(files(c.adapter)).filter((p) => p.startsWith('.obsidian/')).sort();

async function pair(): Promise<[SimClient, SimClient]> {
  const user = await newUser(srv);
  const laptop = await makeClient(srv, user, { name: 'Laptop', vault: 'create', settingsSync: policy });
  const phone = await makeClient(srv, user, { name: 'Phone', vault: laptop.vaultId, settingsSync: policy });
  await laptop.adapter.write(APP, json({ vimMode: false, spellcheck: true, theme: 'x' }));
  await settle([laptop, phone]);
  await phone.reload(); // the phone restarted Obsidian to use the settings it received
  return [laptop, phone];
}

describe('settings files from other devices', () => {
  it('merges changes to different keys made on two devices at once', async () => {
    const [laptop, phone] = await pair();
    await laptop.adapter.write(APP, json({ vimMode: true, spellcheck: true, theme: 'x' }));
    await phone.adapter.write(APP, json({ vimMode: false, spellcheck: false, theme: 'x' }));
    await settle([laptop, phone]);
    expect(read(laptop)).toEqual({ vimMode: true, spellcheck: false, theme: 'x' });
    expect(read(phone)).toEqual(read(laptop));
    expect(configFiles(laptop)).toEqual([APP]);
    expect(configFiles(phone)).toEqual([APP]);
  });

  it('gives a key changed on both devices the value already on the server, with no conflict copy', async () => {
    const [laptop, phone] = await pair();
    await laptop.adapter.write(APP, json({ vimMode: false, spellcheck: true, theme: 'dark' }));
    await phone.adapter.write(APP, json({ vimMode: false, spellcheck: true, theme: 'light' }));
    await laptop.engine.runCycle(); // the laptop's commit lands first
    await settle([laptop, phone]);
    expect(read(phone)).toEqual({ vimMode: false, spellcheck: true, theme: 'dark' });
    expect(read(laptop)).toEqual(read(phone));
    expect(configFiles(phone)).toEqual([APP]);
    expect(phone.events.some((e) => e.type === 'conflict')).toBe(false);
  });

  it('lets the remote file win whole when a side is not a JSON object, and says so', async () => {
    const [laptop, phone] = await pair();
    await laptop.adapter.write(APP, json({ vimMode: true }));
    await phone.adapter.write(APP, new TextEncoder().encode('{"vimMode": fal'));
    await laptop.engine.runCycle();
    await settle([laptop, phone]);
    expect(read(phone)).toEqual({ vimMode: true });
    expect(read(laptop)).toEqual({ vimMode: true });
    expect(phone.events.some((e) => e.type === 'notice' && e.code === 'SETTINGS_REPLACED' && e.path === APP)).toBe(true);
    expect(configFiles(phone)).toEqual([APP]);
  });

  it('pushes only the key changed here when Obsidian rewrites its stale copy before a restart', async () => {
    const [laptop, phone] = await pair();
    await laptop.adapter.write(APP, json({ vimMode: true, spellcheck: true, theme: 'x' }));
    await settle([laptop, phone]);
    expect(read(phone)).toEqual({ vimMode: true, spellcheck: true, theme: 'x' });
    // The phone's Obsidian still holds the settings from before and writes them back with one change.
    await phone.adapter.write(APP, json({ vimMode: false, spellcheck: false, theme: 'x' }));
    await settle([laptop, phone]);
    expect(read(laptop)).toEqual({ vimMode: true, spellcheck: false, theme: 'x' });
    expect(read(phone)).toEqual(read(laptop));
    // Still so after another stale write, and across an engine restart (the plugin did not reload).
    await phone.restart();
    await phone.adapter.write(APP, json({ vimMode: false, spellcheck: false, theme: 'y' }));
    await settle([laptop, phone]);
    expect(read(laptop)).toEqual({ vimMode: true, spellcheck: false, theme: 'y' });
  });

  it('shows one restart notice per cycle, naming the devices', async () => {
    const [laptop, phone] = await pair();
    const notices = () => phone.events.filter((e) => e.type === 'notice' && e.code === 'SETTINGS_APPLIED');
    expect(notices()).toEqual([expect.objectContaining({ count: 1, devices: ['Laptop'] })]);
    await laptop.adapter.write(APP, json({ vimMode: true }));
    await laptop.adapter.write('.obsidian/hotkeys.json', json({ 'editor:save': [] }));
    await laptop.adapter.write('note.md', new TextEncoder().encode('n\n'));
    await laptop.engine.runCycle();
    await phone.engine.runCycle();
    expect(notices()).toHaveLength(2);
    expect(notices()[1]).toMatchObject({ count: 2, devices: ['Laptop'] });
    await phone.engine.runCycle();
    expect(notices()).toHaveLength(2); // nothing new written: no notice
    expect(laptop.events.some((e) => e.type === 'notice' && e.code === 'SETTINGS_APPLIED')).toBe(false);
  });
});
