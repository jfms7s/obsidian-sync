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
import { ManualClock, type Clock } from '../../src/util/clock';
import { MemoryAdapter } from '../../src/vault/memory';
import { App, Modal, Notice, Plugin, Vault, type ButtonComponent, type FakeEl, type Setting, type TextComponent } from '../fakes/obsidian';
import { Net } from '../helpers/net';
import { newUser } from '../helpers/fixture';
import { startServer, type TestServer } from '../helpers/server';
import { totpCode } from '../helpers/totp';

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
  net: Net;
  render(): Promise<void>;
  el(): FakeEl;
  setting(name: string): Setting;
  field(name: string): TextComponent;
  button(text: string): ButtonComponent;
  press(text: string): Promise<void>;
  type(name: string, value: string): void;
  text(): string;
}

async function screen(deviceName: string, opts: { clock?: Clock } = {}): Promise<Screen> {
  const net = new Net();
  const state = await LocalState.open(new IDBFactory(), `ui-${deviceName}-${Math.random()}`);
  const adapter = new MemoryAdapter();
  const app = new App(new Vault());
  const shell = new ShellController({
    state, adapter, configDir: '.obsidian', fetch: net.fetch, webSocket: null, autoRun: false,
    lock: createEngineLock('ui-test', { locks: null, registry: new Map() }),
  });
  const tab = new ObsyncSettingTab(app as unknown as RealApp, new Plugin(app) as never, shell, state, net.fetch, opts.clock);
  const el = () => (tab as unknown as { containerEl: FakeEl }).containerEl;
  const all = (): Setting[] => el().settings;
  const s: Screen = {
    tab, shell, state, adapter, net, el,
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
    expect(Notice.shown.at(-1)?.message).toMatch(/at least 4 words or 16 characters/);
    first.type('Passphrase', 'Tr0ub4dor&3');
    first.type('Repeat the passphrase', 'Tr0ub4dor&3');
    await first.press('Create keys');
    expect(Notice.shown.at(-1)?.message).toMatch(/at least 4 words or 16 characters/);
    expect(await first.state.getPendingKeySetup()).toBeUndefined();
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

    // 4. Create the vault, then choose what not to sync before anything is uploaded; sync starts.
    expect(first.setting('Choose the vault to sync').heading).toBe(true);
    expect(first.field('New vault name').value).toBe('FakeVault');
    await first.press('Create vault');
    expect(first.setting('Choose what not to sync').heading).toBe(true);
    expect(first.shell.engine).toBeNull();
    first.field('Ignored files').type('.venv/\n!keep.md');
    await first.press('Start syncing');
    expect(first.el().allText()).toMatch(/Line 2: !keep\.md/);
    expect(first.shell.engine).toBeNull();
    first.field('Ignored files').type('.venv/\n');
    await first.press('Start syncing');
    expect(await first.shell.ignoreGlobs()).toEqual(['.venv/']);
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
    await second.press('Start syncing');
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
    first.type('Passphrase', 'cat dog sun pie'); // four words, under 16 characters
    first.type('Repeat the passphrase', 'cat dog sun pie');
    await first.press('Create keys');
    await first.press('I have saved them');
    await first.press('Create vault');
    await first.press('Start syncing');
    expect(first.shell.engine).not.toBeNull();

    const second = await screen('phone');
    await second.render();
    second.type('Server address', srv.url);
    second.type('Username', user.username);
    second.type('Password', user.password);
    await second.press('Sign in');
    second.type('Passphrase', 'cat dog sun pie');
    await second.press('Unlock');
    await second.press('Use this vault');
    await second.press('Start syncing');
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
    second.type('Passphrase', 'cat dog sun pie');
    await second.press('Unlock');
    expect(second.setting('Choose the vault to sync').heading).toBe(true);
    await second.press('Use this vault');
    await second.press('Start syncing');
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

    await s.press('Create vault');
    const start = vi.spyOn(s.shell, 'start').mockResolvedValueOnce({ ok: false, reason: 'locked' });
    await s.press('Start syncing');
    expect(Notice.shown.some((n) => n.message.includes('sync has started'))).toBe(false);
    expect(Notice.shown.some((n) => n.message.includes('could not start'))).toBe(true);
    expect(s.text()).toMatch(/could not start/);
    start.mockRestore();

    // The ready screen's Start says why, too.
    await s.press('Start syncing');
    expect(s.setting('Sync').heading).toBe(true);
    await s.shell.stop();
    await s.render();
    Notice.shown = [];
    const again = vi.spyOn(s.shell, 'start').mockResolvedValueOnce({ ok: false, reason: 'locked' });
    await s.press('Start');
    expect(Notice.shown.map((n) => n.message)).toEqual(['Obsync: Sync could not start: this device is locked. Open the settings again to unlock it.']);
    expect(s.text()).toMatch(/could not start/);
    again.mockRestore();
    await s.shell.stop();
  }, 120_000);

  it('shows a large deletion on hold, restores it here, and deletes the next one everywhere after a confirmation', async () => {
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
    await s.press('Start syncing');
    const notes = Array.from({ length: 60 }, (_, i) => `notes/n${i}.md`);
    for (const p of notes) await s.adapter.write(p, new TextEncoder().encode(`${p}\n`));
    await s.shell.engine!.runCycle();
    expect(() => s.setting('Deletions on hold')).toThrow();

    for (const p of notes) await s.adapter.remove(p);
    await s.shell.engine!.runCycle();
    await s.render();
    expect(s.setting('Deletions on hold').desc).toMatch(/^60 files deleted on this device/);
    await s.press('Restore here');
    await s.shell.engine!.runCycle();
    expect(s.adapter.snapshot().size).toBe(60);
    expect(() => s.setting('Deletions on hold')).toThrow();

    for (const p of notes) await s.adapter.remove(p);
    await s.shell.engine!.runCycle();
    await s.render();
    await s.press('Delete on all devices'); // opens the confirmation
    const confirm = Modal.opened.at(-1)!;
    expect(confirm.contentEl.allText()).toMatch(/Delete these 60 files on all your devices/);
    await confirm.contentEl.settings.flatMap((x) => x.buttons).find((b) => b.text === 'Delete on all devices')!.click();
    await new Promise((r) => setTimeout(r, 100));
    await s.shell.engine!.runCycle();
    expect(await s.shell.heldDeletions()).toEqual([]);
    expect(await s.state.dirtyEntries()).toEqual([]);
    expect(s.adapter.snapshot().size).toBe(0);
    await s.shell.stop();
  }, 120_000);

  it('edits the rules for every device in .obsyncignore, listing the lines it skips', async () => {
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
    expect(s.text()).toMatch(/\.obsyncignore apply on every device too/);
    await s.press('Start syncing');

    expect(s.field('Ignored on every device').value).toBe('');
    await s.adapter.write('big/data.md', new TextEncoder().encode('generated\n'));
    await s.adapter.write('note.md', new TextEncoder().encode('note\n'));
    s.type('Ignored on every device', 'big/\n!keep.md\n');
    await s.press('Save for every device');
    expect(new TextDecoder().decode(s.adapter.snapshot().get('.obsyncignore'))).toBe('big/\n!keep.md\n');
    expect(s.text()).toMatch(/Line 2 is skipped: !keep\.md/);
    expect(Notice.shown.some((n) => n.message.includes('1 line is skipped'))).toBe(true);
    await s.shell.engine!.runCycle();
    const vault = (await s.state.getVault())!;
    const api = apiFor((await s.state.getSession())!);
    expect((await api.heads(vault.vaultId, null)).heads).toHaveLength(2); // .obsyncignore and note.md, not big/data.md
    expect(s.shell.engine!.vaultIgnoreFile.globs).toEqual(['big/']);
    await s.render();
    expect(s.field('Ignored on every device').value).toBe('big/\n!keep.md\n');
    await s.shell.stop();
  }, 120_000);

  it('offers to remove files a new rule matches from the server, and does so only when confirmed', async () => {
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
    await s.press('Start syncing');
    await s.adapter.write('.venv/lib/a.py', new TextEncoder().encode('x = 1\n'));
    await s.adapter.write('note.md', new TextEncoder().encode('note\n'));
    await s.shell.engine!.runCycle();
    const vault = (await s.state.getVault())!;
    const api = apiFor((await s.state.getSession())!);
    const live = async () => (await api.heads(vault.vaultId, null)).heads.filter((h) => !h.deleted).length;
    expect(await live()).toBe(2);

    s.type('Ignored files', '.venv/\n');
    await s.press('Save');
    const offer = Modal.opened.at(-1)!;
    expect(offer.contentEl.allText()).toMatch(/The new rules match 1 synced file \(6 B\): \.venv\/lib\/a\.py/);
    expect(offer.contentEl.allText()).toMatch(/move their copies to the trash/);
    await offer.contentEl.settings.flatMap((x) => x.buttons).find((b) => b.text === 'Cancel')!.click();
    await s.shell.engine!.runCycle();
    expect(await live()).toBe(2);

    s.type('Ignored files', '.venv/\n*.pyc\n');
    await s.press('Save');
    expect(Modal.opened).toHaveLength(1); // .venv/lib/a.py was already ignored: nothing new to offer
    s.type('Ignored files', '');
    await s.press('Save');
    s.type('Ignored files', '.venv/\n');
    await s.press('Save');
    const again = Modal.opened.at(-1)!;
    await again.contentEl.settings.flatMap((x) => x.buttons).find((b) => b.text === 'Remove from server')!.click();
    await new Promise((r) => setTimeout(r, 100));
    expect(Notice.shown.some((n) => n.message.includes('removing 1 synced file from the server'))).toBe(true);
    await s.shell.engine!.runCycle();
    expect(await live()).toBe(1);
    expect(s.adapter.snapshot().has('.venv/lib/a.py')).toBe(true);
    await s.shell.stop();
  }, 120_000);

  it('restores a group of deleted files from the trash view with one confirmation', async () => {
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
    await s.press('Start syncing');
    for (const p of ['a.md', 'b.md', 'c.md']) await s.adapter.write(p, new TextEncoder().encode(`${p}\n`));
    await s.shell.engine!.runCycle();
    for (const p of ['a.md', 'b.md', 'c.md']) await s.adapter.remove(p);
    await s.shell.engine!.runCycle();

    await s.press('Show deleted files');
    const trash = Modal.opened.at(-1)!;
    await new Promise((r) => setTimeout(r, 100));
    const buttons = () => trash.contentEl.settings.flatMap((x) => x.buttons);
    expect(trash.contentEl.allText()).toMatch(/3 files deleted on \S/);
    await buttons().find((b) => b.text === 'Restore all 3')!.click();
    const confirm = Modal.opened.at(-1)!;
    expect(confirm.contentEl.allText()).toMatch(/Restore the 3 files deleted on \S/);
    await confirm.contentEl.settings.flatMap((x) => x.buttons).find((b) => b.text === 'Restore 3 files')!.click();
    await new Promise((r) => setTimeout(r, 200));
    expect([...s.adapter.snapshot().keys()].sort()).toEqual(['a.md', 'b.md', 'c.md']);
    expect(Notice.shown.some((n) => n.message.includes('restored 3 of 3 files.'))).toBe(true);
    expect(trash.contentEl.allText()).toMatch(/No deleted files can be restored/);
    await s.shell.engine!.runCycle();
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
    await s.press('Start syncing');

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
    // Signing out revokes the token on the server first: wait for it rather than a fixed time.
    await vi.waitFor(async () => expect(await s.state.getSession()).toBeUndefined(), { timeout: 5000 });
    expect(s.shell.engine).toBeNull();
    await s.render();
    expect(s.setting('Sign in').heading).toBe(true);
  }, 120_000);
  it('shows the storage used, adds the vault line once the account owns two vaults, hides both on a failure, and refreshes after a sync at most once a minute', async () => {
    const user = await newUser(srv);
    const clock = new ManualClock(Date.now());
    const s = await screen('laptop', { clock });
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
    await s.press('Start syncing');
    expect(s.setting('Sync').heading).toBe(true);
    await s.render();
    expect(s.text()).toMatch(/Storage: \d+(\.\d)? (B|KB) of \d+(\.\d)? [KMGT]?B used/);
    expect(s.text()).not.toMatch(/This vault:/);

    // A second vault on the account: the line for this vault appears.
    await apiFor((await s.state.getSession())!).createVault('c'.repeat(32), new Uint8Array(40), [
      { epoch: 0, sealedKey: new Uint8Array(92) }, { epoch: 1, sealedKey: new Uint8Array(92) },
    ]);
    await s.render();
    expect(s.text()).toMatch(/This vault: \d+(\.\d)? (B|KB) \(history and trash included\)/);

    // A failed request shows neither line, and no error.
    s.net.failNextRequest('GET', '/v1/account/usage');
    await s.render();
    expect(s.text()).not.toMatch(/Storage:|This vault:/);
    expect(s.setting('Sync').heading).toBe(true);
    expect(Notice.shown.some((n) => /usage/i.test(n.message))).toBe(false);

    // Uploading changes the number; the refresh after the cycle waits until a minute has passed since the last request.
    await s.render();
    const before = s.net.count('GET', '/v1/account/usage');
    for (let i = 0; i < 5; i++) await s.adapter.write(`n${i}.md`, new TextEncoder().encode('x'.repeat(2000)));
    await s.shell.engine!.runCycle();
    await s.shell.engine!.runCycle();
    expect(s.net.count('GET', '/v1/account/usage')).toBe(before);
    clock.advance(60_000);
    await vi.waitFor(() => expect(s.net.count('GET', '/v1/account/usage')).toBe(before + 1));
    await vi.waitFor(() => expect(s.text()).toMatch(/Storage: \d+(\.\d)? KB of/));
    clock.advance(120_000);
    expect(s.net.count('GET', '/v1/account/usage')).toBe(before + 1); // no sync cycle, no request

    // Once the tab is closed, a sync cycle asks for nothing.
    s.tab.hide();
    await s.shell.engine!.runCycle();
    clock.advance(120_000);
    await new Promise((r) => setTimeout(r, 50));
    expect(s.net.count('GET', '/v1/account/usage')).toBe(before + 1);
    await s.shell.stop();
  }, 120_000);
  it('turns two-step sign-in on, asks a new device for a code only when the server does, and turns it off with a recovery code', async () => {
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
    await s.press('Start syncing');

    expect(s.setting('Two-step sign-in').heading).toBe(true);
    expect(s.setting('Off').desc).toMatch(/authenticator app/);
    s.type('Account password', 'not the password');
    await s.press('Set up');
    expect(s.text()).toMatch(/The account password is wrong\./);
    s.type('Account password', user.password);
    await s.press('Set up');
    const key = s.setting('Key').desc.replace(/ /g, '');
    expect(key).toMatch(/^[A-Z2-7]{32}$/);
    expect(s.setting('Key').desc).toMatch(/^([A-Z2-7]{4} ){7}[A-Z2-7]{4}$/);
    expect(s.setting('Set-up link').desc).toBe(`otpauth://totp/obsync:${user.username}?algorithm=SHA1&digits=6&issuer=obsync&period=30&secret=${key}`);
    s.type('Code from the app', '000000');
    await s.press('Turn on');
    expect(s.text()).toMatch(/The code is wrong or was used already/);
    s.type('Code from the app', totpCode(key));
    await s.press('Turn on');
    const grid = s.el().children.find((c) => c.cls === 'obsync-recovery-words')!;
    const codes = grid.children.map((c) => c.text);
    expect(codes).toHaveLength(10);
    expect(codes[0]).toMatch(/^[0-9a-z]{5}-[0-9a-z]{5}$/);
    await s.press('I have saved them');
    expect(s.setting('On').desc).toMatch(/10 recovery codes left/);

    // A second device: no code field until the server asks for one; what was typed stays.
    const phone = await screen('phone');
    await phone.render();
    phone.type('Server address', srv.url);
    phone.type('Username', user.username);
    phone.type('Password', user.password);
    expect(() => phone.setting('Code')).toThrow();
    await phone.press('Sign in');
    expect(phone.setting('Sign in').heading).toBe(true);
    expect(phone.field('Password').value).toBe(user.password);
    phone.type('Code', '000000');
    await phone.press('Sign in');
    expect(phone.setting('Sign in').heading).toBe(true);
    expect(await phone.state.getSession()).toBeUndefined();
    phone.type('Code', codes[0]!);
    await phone.press('Sign in');
    expect(phone.setting('Unlock this device').heading).toBe(true);

    // Off again, with the password and a recovery code; the laptop never had to sign in again.
    await s.render();
    expect(s.setting('On').desc).toMatch(/9 recovery codes left/);
    s.type('Account password', user.password);
    s.type('Code', codes[1]!);
    await s.press('Turn off');
    expect(s.setting('Off')).toBeTruthy();
    expect(Notice.shown.some((n) => n.message === 'Obsync: two-step sign-in is off.')).toBe(true);
    expect(await s.state.getSession()).toBeDefined();
    await s.shell.stop();
  }, 120_000);

  it('hides the two-step sign-in section when the server cannot say (an older server, or a failure)', async () => {
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
    await s.press('Start syncing');
    const setup = (s.tab as unknown as { setup: { twoStepStatus(): Promise<unknown> } }).setup;
    const old = vi.spyOn(setup, 'twoStepStatus').mockResolvedValueOnce(null);
    await s.render();
    expect(() => s.setting('Two-step sign-in')).toThrow();
    old.mockRejectedValueOnce(new Error('offline'));
    await s.render();
    expect(() => s.setting('Two-step sign-in')).toThrow();
    expect(s.setting('Sync').heading).toBe(true);
    old.mockRestore();
    await s.shell.stop();
  }, 120_000);
});
