import type { ApiClient } from '../api/client';
import type { VaultKeyring } from '../crypto/vaultkeys';
import type { LocalState } from '../state/store';
import type { Clock } from '../util/clock';
import type { Random } from '../util/random';
import type { VaultAdapter } from '../vault/adapter';
import type { IgnoreRules } from '../vault/ignore';
import type { EngineEvent } from './events';

/** Everything push, pull and reconcile need; built and owned by SyncEngine. */
export interface SyncContext {
  api: ApiClient;
  state: LocalState;
  adapter: VaultAdapter;
  ring: VaultKeyring;
  deviceName: string;
  clock: Clock;
  random: Random;
  ignore: IgnoreRules;
  /** Files larger than this are neither uploaded nor downloaded by this device. */
  maxFileBytes: number;
  emit(e: EngineEvent): void;
}

/** 256 MiB: the engine reads whole files into memory, which a phone can afford at this size. */
export const DEFAULT_MAX_FILE_BYTES = 256 << 20;

/** The server's change log went backwards: it was restored from a backup. */
export class ServerRollbackError extends Error {
  constructor(readonly cursor: number, readonly vaultSeq: number) {
    super(`server seq ${vaultSeq} is behind this device's cursor ${cursor}`);
    this.name = 'ServerRollbackError';
  }
}
