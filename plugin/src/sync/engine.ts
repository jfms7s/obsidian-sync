// The sync engine for one vault on one device. All work runs in a single
// serialized loop ("cycle"): pull, reconcile when due, then push rounds
// until nothing is dirty. Triggers (local events, hub notifications,
// timers, reconnects) only set flags and schedule a cycle, so no two pieces
// of sync logic ever touch local state at the same time.
import type { ApiClient } from '../api/client';
import { ApiError, ErrorCode, isAuthFailure, isTemporary, isVaultNotFound, NetworkError } from '../api/errors';
import { HubClient, type WebSocketFactory } from '../api/hub';
import { hubUrl } from '../api/url';
import { MissingEpochKeyError, type VaultKeyring } from '../crypto/vaultkeys';
import type { LocalState } from '../state/store';
import { backoffDelay, DEFAULT_BACKOFF, type BackoffPolicy } from '../util/backoff';
import { systemClock, type Clock, type TimerHandle } from '../util/clock';
import { cryptoRandom, type Random } from '../util/random';
import type { AdapterEvent, VaultAdapter } from '../vault/adapter';
import { IgnoreRules } from '../vault/ignore';
import { DEFAULT_MAX_FILE_BYTES, ServerRollbackError, type SyncContext } from './context';
import { nextRetryAt } from './failures';
import type { EngineEvent, EngineListener, SyncStatus } from './events';
import { pull } from './pull';
import { PushMemory, pushRound } from './push';
import { reconcile } from './reconcile';

export const RECONCILE_INTERVAL_MS = 15 * 60_000;
export const DEBOUNCE_MS = 500;
const MAX_PUSH_ROUNDS_PER_CYCLE = 20;

export interface EngineOptions {
  api: ApiClient;
  state: LocalState;
  adapter: VaultAdapter;
  ring: VaultKeyring;
  deviceName: string;
  clock?: Clock;
  random?: Random;
  ignore?: IgnoreRules;
  /** Opens hub WebSockets; null runs without one (tests, or a manual "sync now" mode). */
  webSocket?: WebSocketFactory | null;
  /**
   * true (default): cycles are scheduled by events and timers. false: only
   * runCycle() runs one; the convergence suite drives engines this way so a
   * seed replays exactly.
   */
  autoRun?: boolean;
  backoff?: BackoffPolicy;
  reconcileIntervalMs?: number;
  debounceMs?: number;
  /** Default 256 MiB (DEFAULT_MAX_FILE_BYTES): larger files are neither uploaded nor downloaded. */
  maxFileBytes?: number;
  /**
   * Fetches the vault's keys again: after STALE_EPOCH, or when a version uses
   * an epoch this device has no key for (sub-project 3). Without it, such a
   * cycle fails and is retried with backoff.
   */
  refreshKeyring?: () => Promise<VaultKeyring>;
}

export class SyncEngine {
  private readonly ctx: SyncContext;
  private readonly clock: Clock;
  private readonly random: Random;
  private readonly autoRun: boolean;
  private readonly mem = new PushMemory();
  private readonly listeners = new Set<EngineListener>();
  private hub: HubClient | null = null;
  private unwatch: (() => void) | null = null;

  private current: SyncStatus = 'stopped';
  private running: Promise<void> | null = null;
  private rerun = false;
  private stopped = true;
  private halted = false; // stopped for good by an auth failure or a lost vault
  private attempt = 0;
  private timer: TimerHandle | null = null;
  private timerAt = Infinity;
  private reconcileTimer: TimerHandle | null = null;
  private applyRetryTimer: TimerHandle | null = null;
  private applyRetryAt = Infinity;

  private reconcileDue = true;
  /** The newest vault seq known: from the last pull, raised by hub notifications. */
  private knownSeq = 0;
  /** The highest seq notified since the last pull began. */
  private notifiedSeq = 0;
  private eventWrites: Promise<unknown> = Promise.resolve();
  /** Epochs the last keyring refresh lacked (SyncContext.unavailableEpochs); checked again with each reconcile interval. */
  private readonly unavailableEpochs = new Set<number>();

  constructor(private readonly opts: EngineOptions) {
    this.clock = opts.clock ?? systemClock;
    this.random = opts.random ?? cryptoRandom;
    this.autoRun = opts.autoRun ?? true;
    this.ctx = {
      api: opts.api,
      state: opts.state,
      adapter: opts.adapter,
      ring: opts.ring,
      deviceName: opts.deviceName,
      clock: this.clock,
      random: this.random,
      ignore: opts.ignore ?? new IgnoreRules([], { caseInsensitive: opts.adapter.caseInsensitive }),
      maxFileBytes: opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
      unavailableEpochs: this.unavailableEpochs,
      emit: (e) => this.emit(e),
    };
  }

  get status(): SyncStatus {
    return this.current;
  }

  on(listener: EngineListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(e: EngineEvent): void {
    for (const l of [...this.listeners]) {
      try {
        l(e);
      } catch {
        // a listener's bug must not break sync
      }
    }
  }

  private setStatus(status: SyncStatus, detail?: string): void {
    if (status === this.current && detail === undefined) return;
    this.current = status;
    this.emit(detail === undefined ? { type: 'status', status } : { type: 'status', status, detail });
  }

  /** Starts watching the vault and, with autoRun, syncing. */
  async start(): Promise<void> {
    if (!this.stopped || this.halted) return;
    this.stopped = false;
    this.reconcileDue = true;
    this.unwatch = this.opts.adapter.watch((ev) => this.onAdapterEvent(ev));
    this.setStatus('syncing');
    if (this.opts.webSocket && this.opts.api.token) {
      this.hub = new HubClient(
        {
          url: hubUrl(this.opts.api.baseUrl), token: this.opts.api.token, vaultIds: [this.ctx.ring.vaultId],
          connect: this.opts.webSocket, clock: this.clock, random: this.random, gate: this.opts.api.gate,
          ...(this.opts.backoff ? { backoff: this.opts.backoff } : {}),
        },
        {
          onNotify: (_vault, seq) => {
            this.knownSeq = Math.max(this.knownSeq, seq);
            this.notifiedSeq = Math.max(this.notifiedSeq, seq);
            this.schedule(0);
          },
          onConnected: () => {
            // Events may have been missed while disconnected.
            this.reconcileDue = true;
            this.schedule(0);
          },
          onDisconnected: () => undefined,
          onAuthFailure: (code, message) => this.halt(code === ErrorCode.DEVICE_REVOKED ? 'DEVICE_REVOKED' : 'UNAUTHORIZED', message),
          onVaultNotFound: () => void this.checkVaultAccess(),
        },
      );
      this.hub.start();
    }
    if (this.autoRun) {
      this.scheduleReconcile();
      this.schedule(0);
    }
  }

  /** Stops syncing; a running cycle finishes first. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.unwatch?.();
    this.unwatch = null;
    this.hub?.stop();
    this.hub = null;
    if (this.timer) this.clock.clearTimeout(this.timer);
    if (this.reconcileTimer) this.clock.clearTimeout(this.reconcileTimer);
    if (this.applyRetryTimer) this.clock.clearTimeout(this.applyRetryTimer);
    this.timer = this.reconcileTimer = this.applyRetryTimer = null;
    this.applyRetryAt = Infinity;
    this.timerAt = Infinity;
    await this.running;
    await this.eventWrites;
    this.setStatus('stopped');
  }

  private halt(code: 'DEVICE_REVOKED' | 'UNAUTHORIZED' | 'VAULT_LOST', message: string): void {
    if (this.halted) return;
    this.halted = true;
    this.emit({ type: 'notice', code, message, persistent: true });
    void this.stop().then(() => this.setStatus('error', message));
  }

  /**
   * The hub's NOT_FOUND frame names no vault, so confirm over HTTP before
   * giving up: only a NOT_FOUND for this vault's keys means access is gone.
   */
  private async checkVaultAccess(): Promise<void> {
    try {
      await this.opts.api.vaultKeys(this.ctx.ring.vaultId);
    } catch (err) {
      if (err instanceof ApiError && err.code === ErrorCode.NOT_FOUND) {
        this.halt('VAULT_LOST', 'the vault was deleted or this account no longer has access to it');
      }
    }
  }

  /** Asks for a cycle soon (e.g. the user pressed "sync now"). */
  requestSync(): void {
    this.schedule(0);
  }

  /** Asks for a full reconcile on the next cycle. */
  requestReconcile(): void {
    this.reconcileDue = true;
    this.schedule(0);
  }

  private onAdapterEvent(ev: AdapterEvent): void {
    const st = this.ctx.state;
    // Recorded strictly in event order, so a later event's gen wins.
    this.eventWrites = this.eventWrites
      .then(async () => {
        if (ev.type === 'rename') {
          await st.markDirty(ev.oldPath);
          await st.markDirty(ev.path, ev.oldPath);
        } else {
          await st.markDirty(ev.path);
        }
      })
      .catch(() => undefined);
    this.schedule(this.opts.debounceMs ?? DEBOUNCE_MS);
  }

  private schedule(delayMs: number): void {
    if (!this.autoRun || this.stopped) return;
    const at = this.clock.now() + delayMs;
    if (this.timer && this.timerAt <= at) return;
    if (this.timer) this.clock.clearTimeout(this.timer);
    this.timerAt = at;
    this.timer = this.clock.setTimeout(() => {
      this.timer = null;
      this.timerAt = Infinity;
      void this.runCycle();
    }, delayMs);
  }

  /** A reconcile at time at, when failed remote versions are due again. */
  private scheduleApplyRetry(at: number): void {
    if (!this.autoRun || this.stopped) return;
    if (this.applyRetryTimer && this.applyRetryAt <= at) return;
    if (this.applyRetryTimer) this.clock.clearTimeout(this.applyRetryTimer);
    this.applyRetryAt = at;
    this.applyRetryTimer = this.clock.setTimeout(() => {
      this.applyRetryTimer = null;
      this.applyRetryAt = Infinity;
      this.reconcileDue = true;
      this.schedule(0);
    }, Math.max(0, at - this.clock.now()));
  }

  private scheduleReconcile(): void {
    this.reconcileTimer = this.clock.setTimeout(() => {
      this.reconcileDue = true;
      this.unavailableEpochs.clear(); // the next version that needs one refreshes the keyring again
      this.schedule(0);
      this.scheduleReconcile();
    }, this.opts.reconcileIntervalMs ?? RECONCILE_INTERVAL_MS);
  }

  /**
   * Runs one cycle now, or joins the running one and runs again after it.
   * Resolves when the work is done; errors are reported as events, never thrown.
   */
  runCycle(): Promise<void> {
    if (this.running) {
      this.rerun = true;
      return this.running;
    }
    this.running = (async () => {
      try {
        do {
          this.rerun = false;
          await this.cycle();
        } while (this.rerun && !this.stopped);
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }

  /** Resolves when no cycle is running and no local event is still being recorded. */
  async whenIdle(): Promise<void> {
    await this.eventWrites;
    while (this.running) await this.running;
  }

  private async cycle(): Promise<void> {
    if (this.halted) return;
    await this.eventWrites;
    this.setStatus('syncing');
    try {
      // The server's seq replaces what was known (it can go down after a
      // restore from a backup); only notifications that arrived during the
      // pull may be ahead of it.
      this.notifiedSeq = 0;
      if (this.reconcileDue) {
        // Cleared first so a request during the reconcile is kept, and set
        // again if it fails, so the retry reconciles too.
        this.reconcileDue = false;
        let r: Awaited<ReturnType<typeof reconcile>>;
        try {
          r = await reconcile(this.ctx);
        } catch (err) {
          this.reconcileDue = true;
          throw err;
        }
        this.knownSeq = Math.max(r.vaultSeq, this.notifiedSeq);
      } else {
        // Every cycle pulls first: it is one request when nothing changed,
        // and pushing on top of the newest heads avoids needless conflicts.
        this.knownSeq = Math.max((await pull(this.ctx)).vaultSeq, this.notifiedSeq);
      }
      for (let round = 0; round < MAX_PUSH_ROUNDS_PER_CYCLE; round++) {
        if (this.stopped) break; // stop() waits for this cycle: do not start more rounds
        await this.eventWrites;
        const r = await pushRound(this.ctx, this.mem);
        if (r.staleEpoch) await this.refreshKeyring();
        // Nothing left, or only entries waiting out a failure's backoff
        // (their retry is scheduled below): another round would spin.
        if (!r.worked || r.attempted === 0) break;
        // Out of rounds while still committing: go on in a fresh cycle.
        if (round === MAX_PUSH_ROUNDS_PER_CYCLE - 1 && r.committed > 0) this.schedule(0);
      }
      this.attempt = 0;
      // Paths waiting out a per-file failure do not keep the status at
      // "syncing"; their notice was shown and a retry is scheduled.
      const failures = await this.ctx.state.allFailures();
      const waiting = new Set(failures.filter((f) => f.key.startsWith('push:')).map((f) => f.key.slice(5)));
      const dirty = (await this.ctx.state.dirtyEntries()).filter((e) => !waiting.has(e.path)).length;
      const cursor = await this.ctx.state.getCursor();
      this.setStatus(dirty === 0 && cursor >= this.knownSeq ? 'synced' : 'syncing');
      if (cursor < this.knownSeq) this.schedule(0);
      // Local files are retried by push, remote versions by reconcile:
      // that one is asked for only when the earliest retry is due, so
      // cycles before then (local edits, notifications) stay cheap.
      const pushRetryAt = await nextRetryAt(this.ctx, 'push:');
      if (pushRetryAt !== null) this.schedule(Math.max(0, pushRetryAt - this.clock.now()));
      const applyRetryAt = await nextRetryAt(this.ctx, 'apply:');
      if (applyRetryAt !== null) this.scheduleApplyRetry(applyRetryAt);
    } catch (err) {
      try {
        await this.onCycleError(err);
      } catch (handlingErr) {
        // Handling failed too (e.g. IndexedDB while forgetting synced
        // versions): back off and try the whole cycle again.
        this.setStatus('error', String((handlingErr as Error)?.message ?? handlingErr));
        this.schedule(backoffDelay(this.attempt++, this.random, this.opts.backoff ?? DEFAULT_BACKOFF));
      }
    }
  }

  private async refreshKeyring(): Promise<void> {
    if (!this.opts.refreshKeyring) throw new ApiError(ErrorCode.STALE_EPOCH, 'the vault key changed and this device cannot fetch it yet', 409);
    this.ctx.ring = await this.opts.refreshKeyring();
    for (const e of [...this.unavailableEpochs]) if (this.ctx.ring.epochs.has(e)) this.unavailableEpochs.delete(e);
  }

  private async onCycleError(err: unknown): Promise<void> {
    if (err instanceof MissingEpochKeyError && this.opts.refreshKeyring && !this.unavailableEpochs.has(err.epoch)) {
      // The vault was re-keyed since this keyring was loaded: fetch the keys
      // and go again at once. If the new keyring still lacks the epoch, the
      // versions that use it fail per file from now on (failures.ts) and
      // this cycle backs off like any other failed one; so does a failed
      // refresh.
      const epoch = err.epoch;
      try {
        await this.refreshKeyring();
        if (this.ctx.ring.epochs.has(epoch)) {
          this.schedule(0);
          return;
        }
        this.unavailableEpochs.add(epoch);
      } catch (refreshErr) {
        err = refreshErr;
      }
    }
    if (err instanceof ServerRollbackError) {
      this.emit({ type: 'notice', code: 'SERVER_ROLLBACK', persistent: false, message: 'the server was restored from a backup; every file is being compared with it again' });
      await this.ctx.state.forgetSyncedVersions();
      this.knownSeq = 0;
      this.reconcileDue = true;
      this.schedule(0);
      return;
    }
    if (isAuthFailure(err)) {
      const e = err as ApiError;
      this.halt(e.code === ErrorCode.DEVICE_REVOKED ? 'DEVICE_REVOKED' : 'UNAUTHORIZED', e.message);
      return;
    }
    if (isVaultNotFound(err)) {
      this.halt('VAULT_LOST', 'the vault was deleted or this account no longer has access to it');
      return;
    }
    if (err instanceof ApiError && err.code === ErrorCode.QUOTA_EXCEEDED) {
      this.emit({ type: 'notice', code: 'QUOTA_EXCEEDED', persistent: true, message: 'the storage quota is used up; changes are kept locally until space is freed' });
    }
    const retryAfter = err instanceof ApiError ? (err.retryAfterMs ?? 0) : 0;
    const delay = backoffDelay(this.attempt++, this.random, this.opts.backoff ?? DEFAULT_BACKOFF, retryAfter);
    if (err instanceof NetworkError) this.setStatus('offline', err.message);
    else this.setStatus('error', isTemporary(err) ? `retrying: ${(err as Error).message}` : String((err as Error)?.message ?? err));
    this.schedule(delay);
  }
}
