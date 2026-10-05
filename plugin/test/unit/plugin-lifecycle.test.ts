// The plugin entry point's lifecycle and where errors go: the status bar after
// setup, a start that must not happen after unload, and errors that must be
// shown to the user instead of only reaching the console.
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NetworkError } from '../../src/api/errors';
import ObsyncPlugin from '../../src/main';
import { ConfirmModal } from '../../src/shell/history-modal';
import { ShellController } from '../../src/shell/controller';
import { ObsyncSettingTab } from '../../src/shell/settings-tab';
import { LocalState } from '../../src/state/store';
import type { EngineEvent } from '../../src/sync/events';
import * as fakeObsidian from '../fakes/obsidian';

const tick = (ms = 30): Promise<void> => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  fakeObsidian.Notice.shown.length = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// The fake's Plugin is what 'obsidian' resolves to under test; the real class is typed by the obsidian package.
function newPlugin(app: fakeObsidian.App): ObsyncPlugin & fakeObsidian.Plugin {
  return new (ObsyncPlugin as unknown as new (app: fakeObsidian.App) => ObsyncPlugin & fakeObsidian.Plugin)(app);
}

const controllerOf = (plugin: ObsyncPlugin): ShellController => (plugin as unknown as { shell: ShellController }).shell;

describe('the plugin entry point', () => {
  it('stops saying "not set up" once an engine reports its status after the setup', async () => {
    const plugin = newPlugin(new fakeObsidian.App(new fakeObsidian.Vault()));
    await plugin.onload();
    await tick();
    const statusEl = plugin.statusItems[0]!;
    expect(statusEl.text).toBe('Obsync: not set up');

    // The settings tab set the account up and started the engine through the controller; it reports as it runs.
    const shell = controllerOf(plugin);
    vi.spyOn(shell, 'status', 'get').mockReturnValue('synced');
    const listeners = (shell as unknown as { listeners: Set<(e: EngineEvent) => void> }).listeners;
    for (const l of [...listeners]) l({ type: 'status', status: 'synced' });

    expect(statusEl.text).toBe('Obsync: synced');
    plugin.onunload();
    await tick();
  });

  it('does not start the engine when the plugin was unloaded before the layout was ready', async () => {
    const start = vi.spyOn(ShellController.prototype, 'start');
    const app = new fakeObsidian.App(new fakeObsidian.Vault());
    let layoutReady: (() => unknown) | null = null;
    app.workspace.onLayoutReady = (cb) => {
      layoutReady = cb;
    };
    const plugin = newPlugin(app);
    await plugin.onload();
    plugin.onunload();
    await tick();

    layoutReady!();
    await tick();

    expect(start).not.toHaveBeenCalled();
    expect(plugin.statusItems[0]!.text).not.toBe('Obsync: not set up');
  });

  it('tells the user when the first start fails', async () => {
    vi.spyOn(ShellController.prototype, 'start').mockRejectedValue(new NetworkError('offline'));
    const plugin = newPlugin(new fakeObsidian.App(new fakeObsidian.Vault()));
    await plugin.onload();
    await tick();

    expect(fakeObsidian.Notice.shown).toEqual([{ message: 'Obsync: Cannot reach the server. Check the address and your connection.', timeout: 10000 }]);
    plugin.onunload();
    await tick();
  });

  it('closes the state when unloading even if the engine fails to stop', async () => {
    const close = vi.spyOn(LocalState.prototype, 'close');
    vi.spyOn(ShellController.prototype, 'stop').mockRejectedValue(new Error('stop failed'));
    const plugin = newPlugin(new fakeObsidian.App(new fakeObsidian.Vault()));
    await plugin.onload();
    await tick();
    plugin.onunload();
    await tick();

    expect(close).toHaveBeenCalledTimes(1);
  });
});

describe('the confirmation dialog', () => {
  it('shows the error of a confirmed action that fails', async () => {
    const app = new fakeObsidian.App(new fakeObsidian.Vault());
    let ran = false;
    new ConfirmModal(app as never, 'Sign out?', 'Sign out', async () => {
      ran = true;
      throw new Error('the server is gone');
    }).open();
    const modal = fakeObsidian.Modal.opened.at(-1)!;
    const button = modal.contentEl.settings[0]!.buttons[0]!;
    expect(button.text).toBe('Sign out');

    await button.click();
    await tick();

    expect(ran).toBe(true);
    expect(fakeObsidian.Notice.shown).toEqual([{ message: 'Obsync: Something went wrong: the server is gone', timeout: 10000 }]);
  });
});

describe('the settings tab', () => {
  it('shows what went wrong when its screen cannot be built, instead of staying on "Loading…"', async () => {
    const session = { serverUrl: 'https://sync.example.com', username: 'ana', userId: 'u1', deviceId: 'd1', deviceName: 'Laptop', token: 't' };
    // A set-up device, offline: the next step is the ready screen.
    const state = {
      getSession: async () => session,
      getVault: async () => ({ userId: 'u1', name: 'Notes' }),
      getUserKeys: async () => ({ userId: 'u1' }),
      getPendingKeySetup: async () => undefined,
    } as unknown as LocalState;
    const fetch = async (): Promise<never> => {
      throw new NetworkError('offline');
    };
    // The ready screen reads the status of the controller; a throw there stands for any failure while it is built.
    const shell = {
      get status(): never {
        throw new Error('cannot read the status');
      },
    } as unknown as ShellController;
    const app = new fakeObsidian.App(new fakeObsidian.Vault());
    const tab = new ObsyncSettingTab(app as never, new fakeObsidian.Plugin(app) as never, shell, state, fetch as never);

    tab.display();
    await tick();

    const text = (tab as unknown as fakeObsidian.PluginSettingTab).containerEl.allText();
    expect(text).not.toContain('Loading…');
    expect(text).toContain('Something went wrong: cannot read the status');
  });
});
