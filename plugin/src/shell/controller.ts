// The plugin's brain, with no Obsidian UI classes in it: it owns the sync
// engine's life (start, stop, restart on a settings change), the lock that
// keeps two engines from running on one vault, and the account actions the
// settings tab calls. The tab and the commands only call this and show
// what it reports.
import type { FetchLike } from '../api/client';
import type { WebSocketFactory } from '../api/hub';
import * as account from '../services/account';
import { openSyncSession, type SyncSessionResult } from '../services/session';
import type { LocalState } from '../state/store';
import type { SyncEngine } from '../sync/engine';
import type { EngineEvent, SyncStatus } from '../sync/events';
import type { Clock } from '../util/clock';
import type { Random } from '../util/random';
import type { VaultAdapter } from '../vault/adapter';
import { IgnoreRules } from '../vault/ignore';
import type { EngineLock } from './engine-lock';
import { HistoryController } from './history-controller';

export interface ShellOptions {
  state: LocalState;
  adapter: VaultAdapter;
  /** Vault.configDir. */
  configDir: string;
  fetch: FetchLike;
  webSocket: WebSocketFactory | null;
  lock: EngineLock;
  /** false: cycles run only when asked (tests). */
  autoRun?: boolean;
  clock?: Clock;
  random?: Random;
}

export type StartResult = { ok: true } | { ok: false; reason: Extract<SyncSessionResult, { ok: false }>['reason'] | 'stopped' };

interface Running {
  engine: SyncEngine;
  history: HistoryController;
  release: () => void;
  off: () => void;
}

export class ShellController {
  private running: Running | null = null;
  private starting: Promise<StartResult> | null = null;
  private wanted = false;
  /** doStart holds the engine lock (it is starting an engine), as opposed to waiting in line for it. */
  private holdsLock = false;
  private readonly listeners = new Set<(e: EngineEvent) => void>();

  constructor(private readonly o: ShellOptions) {}

  /** The running engine (null when not running). */
  get engine(): SyncEngine | null {
    return this.running?.engine ?? null;
  }

  get status(): SyncStatus {
    return this.running?.engine.status ?? 'stopped';
  }

  /** Everything the engine reports, across restarts. */
  on(listener: (e: EngineEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The history view's controller, while syncing. */
  history(): HistoryController | null {
    return this.running?.history ?? null;
  }

  /**
   * Starts syncing the chosen vault once this device is set up (else says
   * what is missing). Waits for a previous plugin instance to stop first.
   */
  start(): Promise<StartResult> {
    this.wanted = true;
    if (this.running) return Promise.resolve({ ok: true });
    this.starting ??= this.doStart().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async doStart(): Promise<StartResult> {
    const release = await this.o.lock.acquire();
    this.holdsLock = true;
    if (!this.wanted) {
      this.holdsLock = false;
      release();
      return { ok: false, reason: 'stopped' };
    }
    try {
      const o = this.o;
      const r = await openSyncSession({
        state: o.state, adapter: o.adapter, webSocket: o.webSocket, fetch: o.fetch, configDir: o.configDir,
        ...(o.clock ? { clock: o.clock } : {}), ...(o.random ? { random: o.random } : {}), ...(o.autoRun !== undefined ? { autoRun: o.autoRun } : {}),
      });
      if (!r.ok) {
        this.holdsLock = false;
        release();
        return r;
      }
      const off = r.engine.on((e) => {
        for (const l of [...this.listeners]) l(e);
      });
      await r.engine.start();
      this.running = { engine: r.engine, history: new HistoryController({ api: r.api, ring: r.ring, adapter: o.adapter, state: o.state }), release, off };
      this.holdsLock = false;
      return { ok: true };
    } catch (err) {
      this.holdsLock = false;
      release();
      throw err;
    }
  }

  /** Stops syncing (after a running cycle) and gives the lock back. Safe to call at any time, also twice. */
  async stop(): Promise<void> {
    this.wanted = false;
    // Still in line for the lock (a previous instance holds it): do not wait for it. The start
    // gives the lock straight back when it is its turn and sees nobody wants the engine.
    if (this.starting && !this.holdsLock) return;
    await this.starting?.catch(() => undefined);
    const r = this.running;
    this.running = null;
    if (!r) return;
    r.off();
    await r.engine.stop();
    r.release();
  }

  async restart(): Promise<StartResult> {
    await this.stop();
    return this.start();
  }

  /** "Sync now": a cycle that also compares everything with the server. */
  syncNow(): void {
    this.running?.engine.requestReconcile();
  }

  async ignoreGlobs(): Promise<string[]> {
    return this.o.state.getSetting<string[]>('ignoreGlobs', []);
  }

  /** Throws InvalidIgnorePatternError for unsupported syntax; otherwise saves the rules and restarts the engine with them. */
  async setIgnoreGlobs(globs: string[]): Promise<void> {
    new IgnoreRules(globs); // validates
    await this.o.state.setSetting('ignoreGlobs', globs);
    if (this.running) await this.restart();
  }

  /** Stops syncing and forgets the account, its keys and the sync state on this device. */
  async logout(): Promise<void> {
    await this.stop();
    await account.logout(this.o.state, { fetch: this.o.fetch, ...(this.o.clock ? { clock: this.o.clock } : {}) });
  }
}
