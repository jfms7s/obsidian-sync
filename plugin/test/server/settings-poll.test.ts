// Obsidian reports no event for its config folder, so the engine looks at
// the settings files the policy syncs every 30 seconds (spec D5).
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import { SETTINGS_POLL_MS } from '../../src/sync/engine';
import type { ManualClock } from '../../src/util/clock';
import { defaultSettingsSyncPolicy, SETTINGS_SYNC_OFF } from '../../src/vault/config-policy';
import { makeClient, settle } from '../helpers/client';
import { files, newUser, text } from '../helpers/fixture';
import { startServer, type TestServer } from '../helpers/server';

let srv: TestServer;
beforeAll(async () => {
  srv = await startServer(inject('obsyncBin'));
});
afterAll(() => srv?.stop());

const HOTKEYS = '.obsidian/hotkeys.json';
const policy = { ...defaultSettingsSyncPolicy(false), pluginData: ['dataview'] };

describe('polling the settings files', () => {
  it('finds a settings change no event reported, and only the files the policy syncs', async () => {
    const user = await newUser(srv);
    const laptop = await makeClient(srv, user, { name: 'Laptop', vault: 'create', settingsSync: policy, hiddenUnwatched: true });
    const phone = await makeClient(srv, user, { name: 'Phone', vault: laptop.vaultId, settingsSync: policy });
    await settle([laptop, phone]);
    await laptop.adapter.write(HOTKEYS, text('{"a":1}'));
    await laptop.adapter.write('.obsidian/workspace.json', text('{}'));
    await laptop.adapter.write('.obsidian/plugins/dataview/main.js', text('code'));
    await laptop.engine.runCycle();
    expect(files(phone.adapter)[HOTKEYS]).toBeUndefined(); // no event: nothing was queued

    expect(await laptop.engine.pollSettings()).toBe(1);
    await settle([laptop, phone]);
    expect(files(phone.adapter)[HOTKEYS]).toBe('{"a":1}');
    expect(await laptop.engine.pollSettings()).toBe(0); // as synced: nothing to do

    await laptop.adapter.write(HOTKEYS, text('{"a":22}'));
    await laptop.adapter.write('.obsidian/plugins/dataview/data.json', text('{"d":1}'));
    expect(await laptop.engine.pollSettings()).toBe(2);
    await settle([laptop, phone]);
    expect(files(phone.adapter)).toEqual({ [HOTKEYS]: '{"a":22}', '.obsidian/plugins/dataview/data.json': '{"d":1}' });
    await laptop.adapter.remove(HOTKEYS);
    expect(await laptop.engine.pollSettings()).toBe(1); // the removal
    await settle([laptop, phone]);
    expect(files(phone.adapter)).toEqual({ '.obsidian/plugins/dataview/data.json': '{"d":1}' });
  });

  it('polls every 30 seconds while the engine runs on its own, and not at all with the policy off', async () => {
    const user = await newUser(srv);
    const laptop = await makeClient(srv, user, { name: 'Laptop', vault: 'create', settingsSync: policy, hiddenUnwatched: true, autoRun: true });
    const clock = laptop.clock as ManualClock;
    clock.advance(0);
    await laptop.engine.whenIdle();
    await laptop.adapter.write(HOTKEYS, text('{"a":1}'));
    clock.advance(SETTINGS_POLL_MS - 1);
    await new Promise((r) => setTimeout(r, 50));
    expect((await laptop.state.dirtyEntries()).map((e) => e.path)).toEqual([]);
    clock.advance(1);
    await vi.waitFor(async () => expect((await laptop.state.dirtyEntries()).map((e) => e.path)).toEqual([HOTKEYS]));
    await laptop.engine.stop();
    expect(clock.pendingTimers()).toBe(0);

    const off = await makeClient(srv, user, { name: 'Off', vault: laptop.vaultId, settingsSync: SETTINGS_SYNC_OFF, hiddenUnwatched: true, autoRun: true });
    const offClock = off.clock as ManualClock;
    offClock.advance(0);
    await off.engine.whenIdle();
    await off.adapter.write(HOTKEYS, text('{"a":2}'));
    offClock.advance(SETTINGS_POLL_MS * 3);
    await new Promise((r) => setTimeout(r, 50));
    expect((await off.state.dirtyEntries()).map((e) => e.path)).toEqual([]);
    expect(await off.engine.pollSettings()).toBe(0);
    await off.engine.stop();
  });
});
