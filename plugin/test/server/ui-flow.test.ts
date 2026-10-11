// The settings tab, driven like a person would (typing into fields and
// pressing buttons of the fake UI) against the real server: first device
// setup, then a second device, then the day-to-day settings.
import { IDBFactory } from 'fake-indexeddb';
import type { App as RealApp } from 'obsidian';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it, vi } from 'vitest';
import { apiFor } from '../../src/services/account';
import { createEngineLock } from '../../src/shell/engine-lock';
import { ShellController } from '../../src/shell/controller';
import { ObsyncSettingTab } from '../../src/shell/settings-tab';
import { LocalState } from '../../src/state/store';
import { MemoryAdapter } from '../../src/vault/memory';
import { App, Modal, Notice, Plugin, Vault, type ButtonComponent, type FakeEl, type Setting, type TextComponent } from '../fakes/obsidian';
import { Net } from '../helpers/net';
import { newUser } from '../helpers/fixture';
import { startServer, type TestServer } from '../helpers/server';

let srv: TestServer;
beforeAll(async () => {
  srv = await startServer(inject('obsyncBin'));
});
afterAll(() => srv?.stop());
beforeEach(() => {
  Notice.shown = [];
  Modal.opened = [];
});

interface Screen {
  tab: ObsyncSettingTab;
  shell: ShellController;
  state: LocalState;
  adapter: MemoryAdapter;
  render(): Promise<void>;
  el(): FakeEl;
  setting(name: string): Setting;
  field(name: string): TextComponent;
  button(text: string): ButtonComponent;
  press(text: string): Promise<void>;
  type(name: string, value: string): void;
  text(): string;
}

async function screen(deviceName: string): Promise<Screen> {
  const net = new Net();
  const state = await LocalState.open(new IDBFactory(), `ui-${deviceName}-${Math.random()}`);
  const adapter = new MemoryAdapter();
  const app = new App(new Vault());
  const shell = new ShellController({
    state, adapter, configDir: '.obsidian', fetch: net.fetch, webSocket: null, autoRun: false,
    lock: createEngineLock('ui-test', { locks: null, registry: new Map() }),
  });
  const tab = new ObsyncSettingTab(app as unknown as RealApp, new Plugin(app) as never, shell, state, net.fetch);
  const el = () => (tab as unknown as { containerEl: FakeEl }).containerEl;
  const all = (): Setting[] => el().settings;
  const s: Screen = {
    tab, shell, state, adapter, el,
    render: () => (tab as unknown as { render(): Promise<void> }).render(),
    setting: (name) => {
      const found = all().find((x) => x.name === name);
      if (!found) throw new Error(`no setting "${name}" on screen:\n${s.text()}`);
      return found;
    },
    field: (name) => s.setting(name).texts[0]!,
    button: (text) => {
      const found = all().flatMap((x) => x.buttons).find((b) => b.text === text);
      if (!found) throw new Error(`no button "${text}" on screen:\n${s.text()}`);
      return found;
    },
    press: async (text) => {
      await s.button(text).click();
      // Pressing a button re-renders the screen without awaiting it from the click handler's caller: wait for that.
      await new Promise((r) => setTimeout(r, 50));
    },
    type: (name, value) => s.field(name).type(value),
    text: () => el().allText(),
  };
  deviceNames.set(s, deviceName);
  return s;
}
const deviceNames = new WeakMap<Screen, string>();

describe('the settings tab', () => {
  it('takes a first device from sign-in to a synced vault, and a second device through unlocking', async () => {
    const user = await newUser(srv);
    const first = await screen('laptop');

    // 1. Sign in
    await first.render();
    expect(first.setting('Sign in').heading).toBe(true);
    first.type('Server address', 'http://example.com'); // not https
    first.type('Username', user.username);
    first.type('Password', user.password);
    expect(first.field('Password').inputEl.type).toBe('password');
    await first.press('Sign in');
    expect(first.text()).toMatch(/must start with https/);
    first.type('Server address', srv.url);
    await first.press('Sign in');

    // 2. Choose a passphrase: too short, different, then fine.
    expect(first.setting('Choose an encryption passphrase').heading).toBe(true);
    first.type('Passphrase', 'short');
    first.type('Repeat the passphrase', 'short');
    await first.press('Create keys');
    expect(first.text()).toMatch(/at least 10 characters/);
    first.type('Passphrase', 'a long enough passphrase');
    first.type('Repeat the passphrase', 'another passphrase!!');
    await first.press('Create keys');
    expect(first.text()).toMatch(/not the same/);
    first.type('Repeat the passphrase', 'a long enough passphrase');
    first.type('Passphrase', user.password);
    first.type('Repeat the passphrase', user.password);
    await first.press('Create keys');
    expect(Notice.shown.at(-1)?.message).toBe('Obsync: Choose a passphrase that is different from your account password.');
    expect(await first.state.getPendingKeySetup()).toBeUndefined();
    expect(await apiFor((await first.state.getSession())!).getKeyBundle()).toBeFalsy();
    first.type('Passphrase', 'a long enough passphrase');
    first.type('Repeat the passphrase', 'a long enough passphrase');
    await first.press('Create keys');

    // 3. The recovery words stay until confirmed (also after a re-render, as after a restart).
    expect(first.setting('Write down your recovery words').heading).toBe(true);
    await first.render();
    const words = first.el().children.find((c) => c.cls === 'obsync-recovery-words')!;
    expect(words.children).toHaveLength(24);
    expect(words.children[0]!.text).toMatch(/^1\. \w+/);
    await first.press('I have saved them');

    // 4. Create the vault; sync starts.
    expect(first.setting('Choose the vault to sync').heading).toBe(true);
    expect(first.field('New vault name').value).toBe('FakeVault');
    await first.press('Create vault');
    expect(first.setting('Sync').heading).toBe(true);
    expect(first.text()).toMatch(/Syncing FakeVault/);
    expect(first.shell.engine).not.toBeNull();
    expect(first.text()).toMatch(/\(this device\)/);

    // A second device: unlock with the passphrase, choose the vault.
    const second = await screen('phone');
    await second.render();
    second.type('Server address', srv.url);
    second.type('Username', user.username);
    second.type('Password', user.password);
    await second.press('Sign in');
    expect(second.setting('Unlock this device').heading).toBe(true);
    second.type('Passphrase', 'not the passphrase');
    await second.press('Unlock');
    expect(second.text()).toMatch(/does not unlock/);
    second.type('Passphrase', 'a long enough passphrase');
    await second.press('Unlock');
    expect(second.setting('Choose the vault to sync').heading).toBe(true);
    expect(second.text()).toContain('FakeVault');
    await second.press('Use this vault');
    expect(second.text()).toMatch(/Syncing FakeVault/);

    // The first device sees the second one and can remove it.
    await first.render();
    expect(first.text()).toMatch(/phone|Mac|Linux PC|Windows PC|Device/);
    await first.shell.stop();
    await second.shell.stop();
  }, 120_000);

  it('lets a device that another device removed sign in again from the settings tab', async () => {
    const user = await newUser(srv);
    const first = await screen('laptop');
    await first.render();
    first.type('Server address', srv.url);
    first.type('Username', user.username);
    first.type('Password', user.password);
    await first.press('Sign in');
    first.type('Passphrase', 'a long enough passphrase');
    first.type('Repeat the passphrase', 'a long enough passphrase');
    await first.press('Create keys');
    await first.press('I have saved them');
    await first.press('Create vault');
    expect(first.shell.engine).not.toBeNull();

    const second = await screen('phone');
    await second.render();
    second.type('Server address', srv.url);
    second.type('Username', user.username);
    second.type('Password', user.password);
    await second.press('Sign in');
    second.type('Passphrase', 'a long enough passphrase');
    await second.press('Unlock');
    await second.press('Use this vault');
    expect(second.shell.engine).not.toBeNull();

    // The first device removes the second one.
    await first.render();
    await first.press('Remove');

    // The second one is told so, and is offered the way back in.
    await second.render();
    expect(second.text()).toMatch(/removed from your account/);
    expect(() => second.button('Try again')).toThrow();
    await second.press('Sign in again');
    expect(await second.state.getSession()).toBeUndefined();
    expect(second.shell.engine).toBeNull();
    expect(second.setting('Sign in').heading).toBe(true);

    // Signing in again, unlocking and choosing the vault starts the sync.
    second.type('Password', user.password);
    await second.press('Sign in');
    expect(second.setting('Unlock this device').heading).toBe(true);
    second.type('Passphrase', 'a long enough passphrase');
    await second.press('Unlock');
    expect(second.setting('Choose the vault to sync').heading).toBe(true);
    await second.press('Use this vault');
    expect(second.shell.engine).not.toBeNull();
    expect(second.text()).toMatch(/Syncing FakeVault/);

    await first.shell.stop();
    await second.shell.stop();
  }, 120_000);

  it('does not say that sync has started when the engine could not start', async () => {
    const user = await newUser(srv);
    const s = await screen('laptop');
    await s.render();
    s.type('Server address', srv.url);
    s.type('Username', user.username);
    s.type('Password', user.password);
    await s.press('Sign in');
    s.type('Passphrase', 'a long enough passphrase');
    s.type('Repeat the passphrase', 'a long enough passphrase');
    await s.press('Create keys');
    await s.press('I have saved them');

    const start = vi.spyOn(s.shell, 'start').mockResolvedValueOnce({ ok: false, reason: 'locked' });
    await s.press('Create vault');
    expect(Notice.shown.some((n) => n.message.includes('sync has started'))).toBe(false);
    expect(Notice.shown.some((n) => n.message.includes('could not start'))).toBe(true);
    expect(s.text()).toMatch(/could not start/);
    start.mockRestore();
    await s.shell.stop();
  }, 120_000);

  it('saves ignore rules, reports bad lines by their line number, and signs out after a confirmation', async () => {
    const user = await newUser(srv);
    const s = await screen('laptop');
    await s.render();
    s.type('Server address', srv.url);
    s.type('Username', user.username);
    s.type('Password', user.password);
    await s.press('Sign in');
    s.type('Passphrase', 'a long enough passphrase');
    s.type('Repeat the passphrase', 'a long enough passphrase');
    await s.press('Create keys');
    await s.press('I have saved them');
    await s.press('Create vault');

    const area = s.field('Ignored files');
    area.type('# my rules\nScratch/\n\n!keep.md');
    await s.press('Save');
    expect(s.el().allText()).toMatch(/Line 4: !keep\.md/);
    expect(await s.shell.ignoreGlobs()).toEqual([]);
    s.field('Ignored files').type('# my rules\nScratch/\n');
    await s.press('Save');
    expect(await s.shell.ignoreGlobs()).toEqual(['Scratch/']);
    expect(Notice.shown.some((n) => n.message.includes('ignore rules saved'))).toBe(true);

    await s.button('Sign out').click(); // opens the confirmation
    const confirm = Modal.opened.at(-1)!;
    expect(confirm.contentEl.allText()).toMatch(/Sign out of Obsync/);
    const confirmButton = confirm.contentEl.settings.flatMap((x) => x.buttons).find((b) => b.text === 'Sign out')!;
    await confirmButton.click();
    await new Promise((r) => setTimeout(r, 100));
    expect(await s.state.getSession()).toBeUndefined();
    expect(s.shell.engine).toBeNull();
    await s.render();
    expect(s.setting('Sign in').heading).toBe(true);
  }, 120_000);
});
