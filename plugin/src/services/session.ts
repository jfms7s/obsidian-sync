// Starting sync for the vault this device has chosen: everything plan 3's
// plugin onload needs in one call.
import type { ApiClient } from '../api/client';
import { defaultWebSocketFactory, type WebSocketFactory } from '../api/hub';
import type { VaultKeyring } from '../crypto/vaultkeys';
import type { LocalState } from '../state/store';
import { SyncEngine } from '../sync/engine';
import type { Clock } from '../util/clock';
import type { Random } from '../util/random';
import type { VaultAdapter } from '../vault/adapter';
import { apiFor, loadUserKeys, type ClientDeps } from './account';
import { keyringFromStored, refreshKeyring } from './vaults';

export interface SyncSessionOptions extends ClientDeps {
  state: LocalState;
  adapter: VaultAdapter;
  webSocket?: WebSocketFactory | null;
  random?: Random;
  clock?: Clock;
  autoRun?: boolean;
  /**
   * The vault's configuration folder (Vault.configDir). Users can move it
   * (.obsidian-mobile, say), and it is never synced under any name.
   */
  configDir: string;
  /** SyncEngine's maxBytesPerRound (the shell sets less on a phone). */
  maxBytesPerRound?: number;
  /** SyncEngine's ownPluginFolders: this plugin's folder name under plugins/. */
  ownPluginFolders?: readonly string[];
}

export type SyncSessionResult =
  | { ok: true; engine: SyncEngine; api: ApiClient; ring: VaultKeyring }
  | { ok: false; reason: 'not-logged-in' | 'locked' | 'no-vault' | 'ignores-unconfirmed' };

/** Builds a SyncEngine from what LocalState holds, or says which setup step is missing. */
export async function openSyncSession(o: SyncSessionOptions): Promise<SyncSessionResult> {
  const session = await o.state.getSession();
  if (!session) return { ok: false, reason: 'not-logged-in' };
  const keys = await loadUserKeys(o.state, session.userId);
  if (!keys) return { ok: false, reason: 'locked' };
  const vault = await o.state.getVault();
  // A vault chosen by another account that logged in here earlier is not this account's to sync.
  if (!vault || vault.userId !== session.userId) return { ok: false, reason: 'no-vault' };
  // Chosen in the setup and the ignore step not confirmed yet: nothing may be uploaded before it is.
  if (vault.ignoresUnconfirmed) return { ok: false, reason: 'ignores-unconfirmed' };
  const deps: ClientDeps = {};
  if (o.fetch) deps.fetch = o.fetch;
  if (o.clock) deps.clock = o.clock;
  const api = apiFor(session, deps);
  const ring = await keyringFromStored(vault);
  const engine = new SyncEngine({
    api, state: o.state, adapter: o.adapter, ring, deviceName: session.deviceName,
    configDir: o.configDir, ignoreGlobs: await o.state.getIgnoreGlobs(), settingsSync: await o.state.getSettingsSync(),
    ...(o.ownPluginFolders ? { ownPluginFolders: o.ownPluginFolders } : {}),
    webSocket: o.webSocket === undefined ? defaultWebSocketFactory : o.webSocket,
    refreshKeyring: () => refreshKeyring(o.state, api, session, keys),
    ...(o.random ? { random: o.random } : {}),
    ...(o.clock ? { clock: o.clock } : {}),
    ...(o.autoRun !== undefined ? { autoRun: o.autoRun } : {}),
    ...(o.maxBytesPerRound !== undefined ? { maxBytesPerRound: o.maxBytesPerRound } : {}),
  });
  return { ok: true, engine, api, ring };
}
