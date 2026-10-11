// The settings layer's allowlist (config-policy.ts): only exact names of
// settings files sync; plugin code, workspaces, themes and Obsync's own
// folder never do, under any spelling.
import { describe, expect, it } from 'vitest';
import { ConfigCarveOut, configPolicy, CORE_SETTINGS_FILES, defaultSettingsSyncPolicy, SETTINGS_SYNC_OFF, settingsFilePaths, type SettingsSyncPolicy } from '../../src/vault/config-policy';
import { IgnoreRules } from '../../src/vault/ignore';

const all: SettingsSyncPolicy = { enabled: true, core: Object.fromEntries(CORE_SETTINGS_FILES.map((f) => [f, true])), pluginData: ['dataview', 'templater', 'obsync', 'mine'] };
const C = '.obsidian';

describe('configPolicy', () => {
  it.each(CORE_SETTINGS_FILES.map((f) => [f]))('syncs %s when on, and only directly in the config folder', (f) => {
    expect(configPolicy(`${C}/${f}`, C, all)).toBe('sync');
    expect(configPolicy(`${C}/${f}`, C, { ...all, core: { ...all.core, [f]: false } })).toBe('skip');
    expect(configPolicy(`${C}/${f}`, C, { ...all, enabled: false })).toBe('skip');
    expect(configPolicy(`${C}/sub/${f}`, C, all)).toBe('skip');
    expect(configPolicy(`notes/${C}/${f}`, C, all)).toBe('skip');
    expect(configPolicy(f, C, all)).toBe('skip');
  });

  it.each([
    'workspace.json', 'workspace-mobile.json', 'workspaces.json', 'graph.json', 'types.json', 'bookmarks.json',
    'plugins/dataview/main.js', 'plugins/dataview/manifest.json', 'plugins/dataview/styles.css', 'plugins/dataview/other.json',
    'plugins/dataview/x/data.json', 'plugins/data.json', 'plugins/dataview/data.json.bak',
    'plugins/obsync/data.json', 'plugins/mine/data.json',
    'themes/Minimal/theme.css', 'themes/Minimal/manifest.json', 'snippets/s.css',
    'plugins/unlisted/data.json',
  ])('never syncs %s', (rest) => {
    expect(configPolicy(`${C}/${rest}`, C, all, ['mine'])).toBe('skip');
  });

  it('syncs the data.json of chosen plugins only', () => {
    expect(configPolicy(`${C}/plugins/dataview/data.json`, C, all)).toBe('sync');
    expect(configPolicy(`${C}/plugins/templater/data.json`, C, all)).toBe('sync');
    expect(configPolicy(`${C}/plugins/templater/data.json`, C, { ...all, pluginData: ['dataview'] })).toBe('skip');
  });

  it.each([
    ['upper case', `${C}/APP.JSON`], ['upper-case folder', '.OBSIDIAN/app.json'], ['upper-case plugin code', `${C}/plugins/dataview/MAIN.JS`],
    ['upper-case data', `${C}/plugins/dataview/DATA.JSON`], ['NFD', `${C}/apṕ.json`], ['short name', 'OBSIDI~1/app.json'],
    ['trailing dot', `${C}/app.json.`], ['trailing space', `${C}/hotkeys.json `], ['stream', `${C}/app.json::$DATA`], ['device name', `${C}/plugins/con/data.json`],
    ['backslash', `${C}\\app.json`], ['dot segment', `${C}/./app.json`], ['parent segment', `${C}/plugins/../app.json`], ['leading slash', `/${C}/app.json`],
  ])('skips another spelling: %s', (_, path) => {
    expect(configPolicy(path, C, all)).toBe('skip');
  });

  it('works on the device\'s own config folder name and no other', () => {
    expect(configPolicy('.obsidian-mobile/app.json', '.obsidian-mobile', all)).toBe('sync');
    expect(configPolicy('.obsidian/app.json', '.obsidian-mobile', all)).toBe('skip');
    expect(configPolicy('.obsidian-mobile/app.json', '/.obsidian-mobile/', all)).toBe('sync');
    expect(configPolicy('app.json', '', all)).toBe('skip');
  });

  it('defaults: off; once on, every core file, a phone keeping its appearance, and no plugin data', () => {
    for (const f of CORE_SETTINGS_FILES) expect(configPolicy(`${C}/${f}`, C, SETTINGS_SYNC_OFF)).toBe('skip');
    const desktop = defaultSettingsSyncPolicy(false);
    const phone = defaultSettingsSyncPolicy(true);
    for (const f of CORE_SETTINGS_FILES) {
      expect(configPolicy(`${C}/${f}`, C, desktop)).toBe('sync');
      expect(configPolicy(`${C}/${f}`, C, phone)).toBe(f === 'appearance.json' ? 'skip' : 'sync');
    }
    expect(desktop.pluginData).toEqual([]);
  });
});

describe('the config folder in the ignore rules', () => {
  const rules = (policy: SettingsSyncPolicy, globs: string[] = [], ci = false) =>
    new IgnoreRules(globs, { configDir: C, caseInsensitive: ci, configSync: new ConfigCarveOut(C, policy, ['mine']) });

  it('stays ignored except for the files the policy syncs', () => {
    const r = rules(all);
    expect(r.matches(`${C}/app.json`)).toBe(false);
    expect(r.matches(`${C}/plugins/dataview/data.json`)).toBe(false);
    expect(r.matches(`${C}/workspace.json`)).toBe(true);
    expect(r.matches(`${C}/plugins/dataview/main.js`)).toBe(true);
    expect(r.matches(`${C}/plugins/mine/data.json`)).toBe(true);
    expect(r.matches(`sub/${C}/app.json`)).toBe(true);
    expect(rules(SETTINGS_SYNC_OFF).matches(`${C}/app.json`)).toBe(true);
  });

  it('keeps the other rules on top of the policy (a union)', () => {
    expect(rules(all, ['*.json']).matches(`${C}/app.json`)).toBe(true);
    expect(rules(all, ['hotkeys.json']).matches(`${C}/hotkeys.json`)).toBe(true);
  });

  it('matches every other spelling of the config folder on a case-insensitive vault', () => {
    const r = rules(all, [], true);
    expect(r.matches('.OBSIDIAN/app.json')).toBe(true);
    expect(r.matches(`${C}/App.json`)).toBe(true);
    expect(r.matches(`${C}/app.json`)).toBe(false);
  });

  it('enters only the folders that can hold a synced file', () => {
    const r = rules(all);
    expect(r.skipsFolder(C)).toBe(false);
    expect(r.skipsFolder(`${C}/plugins`)).toBe(false);
    expect(r.skipsFolder(`${C}/plugins/dataview`)).toBe(false);
    expect(r.skipsFolder(`${C}/plugins/dataview/node_modules`)).toBe(true);
    expect(r.skipsFolder(`${C}/plugins/obsync`)).toBe(true);
    expect(r.skipsFolder(`${C}/plugins/mine`)).toBe(true);
    expect(r.skipsFolder(`${C}/plugins/other`)).toBe(true);
    expect(r.skipsFolder(`${C}/themes`)).toBe(true);
    expect(r.skipsFolder('.git')).toBe(true);
    expect(r.skipsFolder('notes')).toBe(false);
    const coreOnly = rules({ ...all, pluginData: [] });
    expect(coreOnly.skipsFolder(C)).toBe(false);
    expect(coreOnly.skipsFolder(`${C}/plugins`)).toBe(true);
    expect(rules(SETTINGS_SYNC_OFF).skipsFolder(C)).toBe(true);
    expect(rules({ enabled: true, core: {}, pluginData: [] }).skipsFolder(C)).toBe(true);
  });
});

describe('settingsFilePaths', () => {
  it('lists exactly the files the policy syncs', () => {
    expect(settingsFilePaths(C, all, ['mine'])).toEqual([
      ...CORE_SETTINGS_FILES.map((f) => `${C}/${f}`), `${C}/plugins/dataview/data.json`, `${C}/plugins/templater/data.json`,
    ]);
    expect(settingsFilePaths(C, defaultSettingsSyncPolicy(true))).not.toContain(`${C}/appearance.json`);
    expect(settingsFilePaths(C, SETTINGS_SYNC_OFF)).toEqual([]);
    expect(settingsFilePaths(C, { ...all, pluginData: ['a/b', '..', 'con'] })).toHaveLength(CORE_SETTINGS_FILES.length);
  });
});
