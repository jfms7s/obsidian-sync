// Starting sync for the vault this device has chosen: everything plan 3's
// plugin onload needs in one call.
import { defaultWebSocketFactory, type WebSocketFactory } from '../api/hub';
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
}

export type SyncSessionResult =
  | { ok: true; engine: SyncEngine }
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
  const engine = new SyncEngine({
    api, state: o.state, adapter: o.adapter, ring: await keyringFromStored(vault), deviceName: session.deviceName,
    ignore: new IgnoreRules(await o.state.getSetting<string[]>('ignoreGlobs', []), { caseInsensitive: o.adapter.caseInsensitive }),
    webSocket: o.webSocket === undefined ? defaultWebSocketFactory : o.webSocket,
    refreshKeyring: () => refreshKeyring(o.state, api, session, keys),
    ...(o.random ? { random: o.random } : {}),
    ...(o.clock ? { clock: o.clock } : {}),
    ...(o.autoRun !== undefined ? { autoRun: o.autoRun } : {}),
  });
  return { ok: true, engine };
}
