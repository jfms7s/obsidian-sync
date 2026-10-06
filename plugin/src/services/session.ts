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
import { IgnoreRules } from '../vault/ignore';
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
}

export type SyncSessionResult =
  | { ok: true; engine: SyncEngine; api: ApiClient; ring: VaultKeyring }
  | { ok: false; reason: 'not-logged-in' | 'locked' | 'no-vault' };

/** Builds a SyncEngine from what LocalState holds, or says which setup step is missing. */
export async function openSyncSession(o: SyncSessionOptions): Promise<SyncSessionResult> {
  const session = await o.state.getSession();
  if (!session) return { ok: false, reason: 'not-logged-in' };
  const keys = await loadUserKeys(o.state, session.userId);
  if (!keys) return { ok: false, reason: 'locked' };
  const vault = await o.state.getVault();
  // A vault chosen by another account that logged in here earlier is not this account's to sync.
  if (!vault || vault.userId !== session.userId) return { ok: false, reason: 'no-vault' };
  const deps: ClientDeps = {};
  if (o.fetch) deps.fetch = o.fetch;
  if (o.clock) deps.clock = o.clock;
  const api = apiFor(session, deps);
  const ring = await keyringFromStored(vault);
  const engine = new SyncEngine({
    api, state: o.state, adapter: o.adapter, ring, deviceName: session.deviceName,
    ignore: new IgnoreRules(await o.state.getSetting<string[]>('ignoreGlobs', []), { caseInsensitive: o.adapter.caseInsensitive, configDir: o.configDir }),
    webSocket: o.webSocket === undefined ? defaultWebSocketFactory : o.webSocket,
    refreshKeyring: () => refreshKeyring(o.state, api, session, keys),
    ...(o.random ? { random: o.random } : {}),
    ...(o.clock ? { clock: o.clock } : {}),
    ...(o.autoRun !== undefined ? { autoRun: o.autoRun } : {}),
  });
  return { ok: true, engine, api, ring };
}
