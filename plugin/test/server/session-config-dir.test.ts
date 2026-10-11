// The vault's configuration folder: never synced, except the settings files
// a device's settings sync policy names (config-policy.ts), under the
// folder's real name.
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { openSyncSession } from '../../src/services/session';
import { defaultSettingsSyncPolicy, type SettingsSyncPolicy } from '../../src/vault/config-policy';
import { files, newDevice, newUser, text, type User } from '../helpers/fixture';
import { makeClient, settle } from '../helpers/client';
import { startServer, type TestServer } from '../helpers/server';

let srv: TestServer;
beforeAll(async () => {
  srv = await startServer(inject('obsyncBin'));
});
afterAll(() => srv?.stop());

it('ignores the vault\'s configuration folder under its real name', async () => {
  const user = await newUser(srv);
  const dev = await newDevice(srv, user, { name: 'Laptop', vault: 'create' });
  const other = await makeClient(srv, user, { name: 'Phone', vault: dev.vaultId });
  const r = await openSyncSession({ state: dev.state, adapter: dev.adapter, webSocket: null, fetch: dev.net.fetch, clock: dev.clock, random: dev.random, autoRun: false, configDir: '.obsidian-mobile' });
  if (!r.ok) throw new Error(r.reason);
  await dev.adapter.write('.obsidian-mobile/workspace.json', text('{}'));
  await dev.adapter.write('note.md', text('n\n'));
  await r.engine.start();
  await r.engine.runCycle();
  await settle([other]);
  expect(files(other.adapter)).toEqual({ 'note.md': 'n\n' });
  await r.engine.stop();
});

const desktop = defaultSettingsSyncPolicy(false);
const withPlugins = (ids: string[], base: SettingsSyncPolicy = desktop): SettingsSyncPolicy => ({ ...base, pluginData: ids });

/** The settings files and plugin code a laptop has in its config folder. */
async function configFolder(c: { adapter: { write(p: string, d: Uint8Array): Promise<boolean> } }, tag: string): Promise<void> {
  for (const f of ['app.json', 'appearance.json', 'hotkeys.json', 'core-plugins.json', 'community-plugins.json', 'workspace.json', 'workspace-mobile.json']) {
    await c.adapter.write(`.obsidian/${f}`, text(`{"from":"${tag}"}`));
  }
  for (const f of ['main.js', 'manifest.json', 'styles.css', 'data.json']) await c.adapter.write(`.obsidian/plugins/dataview/${f}`, text(`/* ${tag} */`));
  await c.adapter.write('.obsidian/plugins/obsync/data.json', text(`{"from":"${tag}"}`));
  await c.adapter.write('.obsidian/themes/T/theme.css', text(`/* ${tag} */`));
  await c.adapter.write('.obsidian/snippets/s.css', text(`/* ${tag} */`));
}

async function pair(user: User, a: SettingsSyncPolicy, b: SettingsSyncPolicy) {
  const laptop = await makeClient(srv, user, { name: 'Laptop', vault: 'create', settingsSync: a });
  const phone = await makeClient(srv, user, { name: 'Phone', vault: laptop.vaultId, settingsSync: b });
  return [laptop, phone] as const;
}

describe('settings sync', () => {
  it('sends the chosen settings files and never plugin code, workspaces, themes, snippets or Obsync\'s own folder', async () => {
    const [laptop, phone] = await pair(await newUser(srv), withPlugins(['dataview', 'obsync']), withPlugins(['dataview', 'obsync']));
    await configFolder(laptop, 'laptop');
    await settle([laptop, phone]);
    expect(files(phone.adapter)).toEqual({
      '.obsidian/app.json': '{"from":"laptop"}',
      '.obsidian/appearance.json': '{"from":"laptop"}',
      '.obsidian/hotkeys.json': '{"from":"laptop"}',
      '.obsidian/core-plugins.json': '{"from":"laptop"}',
      '.obsidian/community-plugins.json': '{"from":"laptop"}',
      '.obsidian/plugins/dataview/data.json': '/* laptop */',
    });
    // What reached the server at all: nothing else.
    expect((await laptop.api.heads(laptop.vaultId, null)).heads).toHaveLength(6);
  });

  it('carries a changed hotkeys.json to the other device', async () => {
    const [laptop, phone] = await pair(await newUser(srv), desktop, desktop);
    await laptop.adapter.write('.obsidian/hotkeys.json', text('{"a":1}'));
    await settle([laptop, phone]);
    await laptop.adapter.write('.obsidian/hotkeys.json', text('{"a":2}'));
    await settle([laptop, phone]);
    expect(files(phone.adapter)['.obsidian/hotkeys.json']).toBe('{"a":2}');
  });

  it('keeps a device\'s own copy of a file it does not sync', async () => {
    const phonePolicy = defaultSettingsSyncPolicy(true); // appearance.json off
    const [laptop, phone] = await pair(await newUser(srv), desktop, phonePolicy);
    await phone.adapter.write('.obsidian/appearance.json', text('{"theme":"phone"}'));
    await laptop.adapter.write('.obsidian/appearance.json', text('{"theme":"laptop"}'));
    await laptop.adapter.write('.obsidian/app.json', text('{"from":"laptop"}'));
    await settle([laptop, phone]);
    expect(files(phone.adapter)['.obsidian/appearance.json']).toBe('{"theme":"phone"}');
    expect(files(phone.adapter)['.obsidian/app.json']).toBe('{"from":"laptop"}');
    expect((await phone.state.filesByPath('.obsidian/appearance.json'))[0]?.ignored).toBe(true);
    // Turning it on applies the laptop's version (the existing re-check of ignored records).
    await phone.setSettingsSync(desktop);
    await settle([laptop, phone]);
    expect(files(phone.adapter)['.obsidian/appearance.json']).toBeDefined();
    expect(files(laptop.adapter)['.obsidian/appearance.json']).toBe(files(phone.adapter)['.obsidian/appearance.json']);
  });

  it('sends and receives nothing from the config folder while the master switch is off', async () => {
    const [laptop, phone] = await pair(await newUser(srv), desktop, { ...desktop, enabled: false });
    await configFolder(laptop, 'laptop');
    await configFolder(phone, 'phone');
    await laptop.adapter.write('note.md', text('n\n'));
    await settle([laptop, phone]);
    // The laptop's settings reached the server, the phone wrote none of them and sent none of its own.
    const phoneFiles = files(phone.adapter);
    expect(phoneFiles['note.md']).toBe('n\n');
    expect(phoneFiles['.obsidian/app.json']).toBe('{"from":"phone"}');
    expect(phoneFiles['.obsidian/hotkeys.json']).toBe('{"from":"phone"}');
    expect(files(laptop.adapter)['.obsidian/app.json']).toBe('{"from":"laptop"}');
    expect((await laptop.api.heads(laptop.vaultId, null)).heads).toHaveLength(6); // note.md and the laptop's five core files
  });
});
