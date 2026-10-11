// Which files in the vault's configuration folder sync (the settings layer,
// slice one: spec 2026-10-11-settings-layer-design). The folder holds this
// device's settings and its plugins' code, and Obsidian runs that code, so
// the rule is an allowlist of exact names, never a glob or a prefix:
// Obsidian's five core settings files directly in the folder, and the
// data.json of community plugins the user chose. Everything else in the
// folder (plugin code, themes, snippets, workspaces, Obsync's own folder)
// never syncs, whatever the policy says.
import { normalizePath } from '../util/path';

/** Obsidian's core settings files that may sync, directly in the config folder. */
export const CORE_SETTINGS_FILES = ['app.json', 'appearance.json', 'hotkeys.json', 'core-plugins.json', 'community-plugins.json'] as const;
export type CoreSettingsFile = (typeof CORE_SETTINGS_FILES)[number];

/** This plugin's id (manifest.json): its own folder never syncs, under any device's policy. */
export const OBSYNC_PLUGIN_ID = 'obsync';

/** One device's choice of what in the config folder syncs (stored per device, never synced). */
export interface SettingsSyncPolicy {
  /** The master switch: off, nothing in the config folder syncs. */
  enabled: boolean;
  /** The core settings files this device syncs (a file not named is not synced). */
  core: Partial<Record<CoreSettingsFile, boolean>>;
  /** Folder names under plugins/ whose data.json this device syncs. */
  pluginData: readonly string[];
}

/** The policy of a device that never turned settings sync on (the default, also after an upgrade). */
export const SETTINGS_SYNC_OFF: SettingsSyncPolicy = { enabled: false, core: {}, pluginData: [] };

/** What a device starts from when the user turns settings sync on: every core file, but a phone keeps its own appearance; no plugin data. */
export function defaultSettingsSyncPolicy(mobile: boolean): SettingsSyncPolicy {
  const core: Partial<Record<CoreSettingsFile, boolean>> = {};
  for (const f of CORE_SETTINGS_FILES) core[f] = !(mobile && f === 'appearance.json');
  return { enabled: true, core, pluginData: [] };
}

/** A name of one folder under plugins/ (no separator, not '.' or '..'). */
function isPluginFolderName(id: string): boolean {
  return id !== '' && id !== '.' && id !== '..' && !id.includes('/') && !id.includes('\\');
}

/**
 * 'sync' only for a path that is exactly `${configDir}/<core file>` for a
 * core file the policy turns on, or exactly `${configDir}/plugins/<id>/data.json`
 * for an id in the policy's list that is not Obsync's own folder
 * (OBSYNC_PLUGIN_ID or one of ownPluginFolders); 'skip' for everything
 * else, and for everything while the policy is off. Names compare exactly,
 * case included: a differently spelled name is another file, or on a
 * case-insensitive disk one Obsidian did not write. A path normalizePath
 * refuses (an NTFS alias such as OBSIDI~1, a device name) is skipped.
 */
export function configPolicy(path: string, configDir: string, policy: SettingsSyncPolicy, ownPluginFolders: readonly string[] = []): 'sync' | 'skip' {
  if (!policy.enabled) return 'skip';
  const dir = configDir.replace(/^\/+|\/+$/g, '');
  if (dir === '') return 'skip';
  try {
    if (normalizePath(path) !== path) return 'skip';
  } catch {
    return 'skip';
  }
  if (!path.startsWith(`${dir}/`)) return 'skip';
  const rest = path.slice(dir.length + 1).split('/');
  if (rest.length === 1) {
    const name = rest[0]!;
    return (CORE_SETTINGS_FILES as readonly string[]).includes(name) && policy.core[name as CoreSettingsFile] === true ? 'sync' : 'skip';
  }
  if (rest.length === 3 && rest[0] === 'plugins' && rest[2] === 'data.json') {
    const id = rest[1]!;
    return pluginDataSyncs(id, policy, ownPluginFolders) ? 'sync' : 'skip';
  }
  return 'skip';
}

function pluginDataSyncs(id: string, policy: SettingsSyncPolicy, ownPluginFolders: readonly string[]): boolean {
  if (!isPluginFolderName(id) || id === OBSYNC_PLUGIN_ID || ownPluginFolders.includes(id)) return false;
  return policy.pluginData.includes(id);
}

/** The policy bound to one config folder, as the ignore rules use it. */
export class ConfigCarveOut {
  private readonly dir: string;

  constructor(configDir: string, private readonly policy: SettingsSyncPolicy, private readonly ownPluginFolders: readonly string[] = []) {
    this.dir = configDir.replace(/^\/+|\/+$/g, '');
  }

  /** The config folder's rule does not cover path: the policy syncs it. */
  syncs(path: string): boolean {
    return configPolicy(path, this.dir, this.policy, this.ownPluginFolders) === 'sync';
  }

  /** A folder of the config folder that may hold a file the policy syncs, so a walk of the vault must enter it. */
  mayHoldSynced(folder: string): boolean {
    const p = this.policy;
    if (!p.enabled) return false;
    const plugins = p.pluginData.filter((id) => pluginDataSyncs(id, p, this.ownPluginFolders));
    if (folder === this.dir) return plugins.length > 0 || CORE_SETTINGS_FILES.some((f) => p.core[f] === true);
    if (folder === `${this.dir}/plugins`) return plugins.length > 0;
    const prefix = `${this.dir}/plugins/`;
    return folder.startsWith(prefix) && plugins.includes(folder.slice(prefix.length));
  }
}
