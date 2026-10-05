// What ships is the esbuild bundle, not the sources: check that it can load
// in Obsidian (only 'obsidian' is required from outside, no Node modules)
// and that the plugin it exports starts, with the fake obsidian module.
import { build } from 'esbuild';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { options } from '../../esbuild.config.mjs';
import * as fakeObsidian from '../fakes/obsidian';

afterEach(() => vi.unstubAllGlobals());

async function bundle(): Promise<string> {
  const result = await build({ ...options, outfile: 'main.js', write: false, sourcemap: false, logLevel: 'silent' });
  return result.outputFiles![0]!.text;
}

describe('the plugin bundle', () => {
  it('requires nothing but obsidian and stays a reasonable size', async () => {
    const code = await bundle();
    const required = [...code.matchAll(/require\((["'])([^"']+)\1\)/g)].map((m) => m[2]);
    expect(new Set(required)).toEqual(new Set(['obsidian']));
    expect(code).not.toMatch(/from ["']node:/);
    expect(code.length).toBeLessThan(2_000_000);
    // BigInt literals and class fields are fine at ES2020; top-level await would not be.
    expect(code).not.toMatch(/^await /m);
  });

  it('exports a plugin that loads, registers its commands and settings tab, and unloads', async () => {
    vi.stubGlobal('indexedDB', new IDBFactory());
    const code = await bundle();
    const module = { exports: {} as { default?: new (app: fakeObsidian.App) => fakeObsidian.Plugin & { onload(): Promise<void>; onunload(): void } } };
    const requireFake = (name: string): unknown => {
      if (name !== 'obsidian') throw new Error(`unexpected require(${name})`);
      return fakeObsidian;
    };
    new Function('module', 'exports', 'require', code)(module, module.exports, requireFake);
    const Plugin = module.exports.default!;
    const app = new fakeObsidian.App(new fakeObsidian.Vault());
    const plugin = new Plugin(app);
    await plugin.onload();
    expect(plugin.commands.map((c) => c.id)).toEqual(['sync-now', 'file-history', 'restore-deleted']);
    expect(plugin.commands.map((c) => c.name).every((n) => !/command/i.test(n))).toBe(true);
    expect(plugin.settingTabs).toHaveLength(1);
    expect(plugin.ribbon.map((r) => r.title)).toEqual(['Obsync: sync now']);
    // Not signed in: the status bar says so once the layout is ready and the start has been refused.
    await new Promise((r) => setTimeout(r, 50));
    expect(plugin.statusItems[0]!.text).toBe('Obsync: not set up');
    // File history needs a running sync and an open file.
    expect(plugin.commands[1]!.checkCallback!(true)).toBe(false);
    plugin.onunload();
    await new Promise((r) => setTimeout(r, 20));
  });

  it('keeps this vault\'s state under a name of its own, kept in local storage', async () => {
    vi.stubGlobal('indexedDB', new IDBFactory());
    const code = await bundle();
    const module = { exports: {} as { default?: new (app: fakeObsidian.App) => fakeObsidian.Plugin & { onload(): Promise<void>; onunload(): void } } };
    new Function('module', 'exports', 'require', code)(module, module.exports, () => fakeObsidian);
    const app = new fakeObsidian.App(new fakeObsidian.Vault());
    const plugin = new module.exports.default!(app);
    await plugin.onload();
    const key = app.loadLocalStorage('obsync-instance');
    expect(key).toMatch(/^[0-9a-f]{16}$/);
    plugin.onunload();
    await new Promise((r) => setTimeout(r, 20));
    const again = new module.exports.default!(app);
    await again.onload();
    expect(app.loadLocalStorage('obsync-instance')).toBe(key);
    again.onunload();
    await new Promise((r) => setTimeout(r, 20));
  });
});
