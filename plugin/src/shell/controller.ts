// The plugin's brain, with no Obsidian UI classes in it: it owns the sync
// engine's life (start, stop, restart on a settings change), the lock that
// keeps two engines from running on one vault, the ignore rules and logout.
// The setup steps live in SetupController. The tab and the commands only
// call these and show what they report.
import type { FetchLike } from '../api/client';
import type { WebSocketFactory } from '../api/hub';
import * as account from '../services/account';
import { openSyncSession, type SyncSessionResult } from '../services/session';
import type { LocalState } from '../state/store';
import { heldDeletions, releaseHeldDeletions, restoreHeldDeletions } from '../sync/deletion-hold';
import { composeIgnoreRules, type SyncEngine } from '../sync/engine';
import type { EngineEvent, SyncStatus } from '../sync/events';
import type { RestartBase } from '../sync/settings-files';
import { systemClock, type Clock } from '../util/clock';
import type { Random } from '../util/random';
import type { VaultAdapter } from '../vault/adapter';
import { approveServerRemoval, newlyIgnored, type NewlyIgnored } from '../sync/server-removal';
import { assertValidIgnorePatterns, parseIgnoreFile, VAULT_IGNORE_FILE, type IgnoreRules, type ParsedIgnoreFile } from '../vault/ignore';
import type { EngineLock } from './engine-lock';
import { startHeartbeat, type HeartbeatSink } from './heartbeat';
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
  /** SyncEngine's maxBytesPerRound (main.ts sets less on a phone). */
  maxBytesPerRound?: number;
  /** This plugin's folder name under plugins/ (manifest.dir): its files never sync, whatever the settings sync policy says. */
  ownPluginFolders?: readonly string[];
  /** Where to keep the heartbeat that tells obsync-cli on this folder to hold off while the engine runs (none: no heartbeat). */
  heartbeat?: HeartbeatSink;
}

export type StartResult = { ok: true } | { ok: false; reason: Extract<SyncSessionResult, { ok: false }>['reason'] | 'stopped' };

export interface StartOptions {
  /**
   * The user asked to start (the settings tab's buttons): this also lifts
   * a stopForGood. Other starts (the plugin's start at load, a restart for
   * new settings) are refused while it holds.
   */
  byUser?: boolean;
}

interface Running {
  engine: SyncEngine;
  history: HistoryController;
  release: () => void;
  off: () => void;
  /** Stops the heartbeat and removes its file. */
  stopHeartbeat: () => Promise<void>;
}

/**
 * Where the engine's life is:
 * - idle: no engine, no lock.
 * - queued: a start waits in line for the lock (another plugin instance, or
 *   this one's engine still stopping, holds it). It gives the lock straight
 *   back when its turn comes and nobody wants the engine any more.
 * - starting: a start holds the lock and is opening the session and the engine.
 * - running: an engine runs and holds the lock.
 * - stopping: the engine is finishing its cycle; the lock is given back after.
 */
type Phase = 'idle' | 'queued' | 'starting' | 'running' | 'stopping';

export class ShellController {
  private phase: Phase = 'idle';
  private running: Running | null = null;
  /** The start in progress (queued or starting), shared by every start() call meanwhile. */
  private starting: Promise<StartResult> | null = null;
  /** The stop in progress (phase stopping). */
  private stopping: Promise<void> | null = null;
  /** The intent of the last start() or stop() call: last call wins. */
  private wanted = false;
  /** stopForGood was called and no start({ byUser: true }) since. */
  private held = false;
  /** The last start that got as far as opening the session found this device not set up. */
  private lastStartNeedsSetup = false;
  private readonly listeners = new Set<(e: EngineEvent) => void>();
  /** Settings files written from other devices since the plugin loaded (SyncContext.restartBases): kept across engine restarts. */
  private readonly restartBases = new Map<string, RestartBase>();

  constructor(private readonly o: ShellOptions) {}

  /** The running engine (null when not running). */
  get engine(): SyncEngine | null {
    return this.running?.engine ?? null;
  }

  get status(): SyncStatus {
    return this.running?.engine.status ?? 'stopped';
  }

  /** Nothing syncs because the last start found the setup unfinished (not signed in, locked, no vault). */
  get setupNeeded(): boolean {
    return this.lastStartNeedsSetup && this.status === 'stopped';
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
   * what is missing). Waits for a previous plugin instance, or this one's
   * engine, to stop first. After stopForGood only a start({ byUser: true })
   * starts; others resolve { ok: false, reason: 'stopped' }.
   */
  start(opts: StartOptions = {}): Promise<StartResult> {
    if (opts.byUser) this.held = false;
    if (this.held) return Promise.resolve({ ok: false, reason: 'stopped' });
    this.wanted = true;
    if (this.phase === 'running') return Promise.resolve({ ok: true });
    this.starting ??= this.doStart().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async doStart(): Promise<StartResult> {
    // This instance's previous engine first: it holds the lock until it has stopped.
    while (this.stopping) await this.stopping.catch(() => undefined);
    if (!this.wanted) return { ok: false, reason: 'stopped' };
    this.phase = 'queued';
    const release = await this.o.lock.acquire();
    if (!this.wanted) {
      this.phase = 'idle';
      release();
      return { ok: false, reason: 'stopped' };
    }
    this.phase = 'starting';
    try {
      const o = this.o;
      const r = await openSyncSession({
        state: o.state, adapter: o.adapter, webSocket: o.webSocket, fetch: o.fetch, configDir: o.configDir,
        ...(o.clock ? { clock: o.clock } : {}), ...(o.random ? { random: o.random } : {}), ...(o.autoRun !== undefined ? { autoRun: o.autoRun } : {}),
        ...(o.maxBytesPerRound !== undefined ? { maxBytesPerRound: o.maxBytesPerRound } : {}),
        ...(o.ownPluginFolders ? { ownPluginFolders: o.ownPluginFolders } : {}),
        restartBases: this.restartBases,
      });
      this.lastStartNeedsSetup = !r.ok;
      if (!r.ok) {
        this.phase = 'idle';
        release();
        return r;
      }
      // Read before the engine starts: a failure after it would leave an engine no stop() reaches.
      const device = (await o.state.getSession())?.deviceName ?? '';
      const off = r.engine.on((e) => {
        for (const l of [...this.listeners]) l(e);
      });
      try {
        await r.engine.start();
      } catch (err) {
        off();
        await r.engine.stop().catch(() => undefined);
        throw err;
      }
      const stopHeartbeat = o.heartbeat ? startHeartbeat(o.heartbeat, o.clock ?? systemClock, device) : async () => undefined;
      this.running = { engine: r.engine, history: new HistoryController({ api: r.api, ring: r.ring, adapter: o.adapter, state: o.state }), release, off, stopHeartbeat };
      this.phase = 'running';
      return { ok: true };
    } catch (err) {
      this.phase = 'idle';
      release();
      throw err;
    }
  }

  /**
   * Stops syncing (after a running cycle) and gives the lock back. Safe to
   * call at any time, also several times at once.
   *
   * When it resolves, no engine of this controller runs and it holds no
   * lock; a start still in line for the lock (another instance holds it)
   * gives the lock straight back when its turn comes. Unless start() was
   * called after this stop(): the later call wins, and the engine may run.
   * Use stopForGood when that must not happen.
   */
  async stop(): Promise<void> {
    this.wanted = false;
    for (;;) {
      if (this.wanted) return; // started again since: the later call wins
      switch (this.phase) {
        case 'idle':
        case 'queued':
          return;
        case 'starting':
          await this.starting?.catch(() => undefined);
          break;
        case 'stopping':
          await this.stopping;
          break;
        case 'running':
          this.beginStop();
          break;
      }
    }
  }

  /**
   * stop(), and no engine starts again until start({ byUser: true }): for
   * logging out and switching vaults, which change the local state and
   * need no engine to run meanwhile, whatever else asks to start.
   */
  stopForGood(): Promise<void> {
    this.held = true;
    return this.stop();
  }

  private beginStop(): void {
    const r = this.running!;
    this.running = null;
    this.phase = 'stopping';
    this.stopping = (async () => {
      try {
        r.off();
        await r.engine.stop();
      } finally {
        await r.stopHeartbeat();
        r.release();
        this.stopping = null;
        this.phase = 'idle';
      }
    })();
  }

  async restart(): Promise<StartResult> {
    await this.stop();
    return this.start();
  }

  /** The local deletions on hold: a large deletion waits for the user before it reaches other devices. */
  heldDeletions(): Promise<string[]> {
    return heldDeletions(this.o.state);
  }

  /** "Delete on all devices": pushes the held deletions. Returns how many. */
  async deleteHeldEverywhere(): Promise<number> {
    const n = await releaseHeldDeletions(this.o.state);
    this.running?.engine.requestSync();
    return n;
  }

  /** "Restore here": writes the held files again from the server. Returns how many. */
  async restoreHeldHere(): Promise<number> {
    const n = await restoreHeldDeletions(this.o.state);
    this.running?.engine.requestReconcile();
    return n;
  }

  /** "Sync now": a cycle that also compares everything with the server. False when no engine runs, so nothing happened. */
  syncNow(): boolean {
    if (!this.running) return false;
    this.running.engine.requestReconcile();
    return true;
  }

  async ignoreGlobs(): Promise<string[]> {
    return this.o.state.getIgnoreGlobs();
  }

  /**
   * Throws InvalidIgnorePatternError for unsupported syntax; otherwise saves
   * the rules and restarts the engine with them. A start still in line for
   * the lock reads them when its turn comes; one already past that is
   * restarted. Returns the synced files the new rules newly ignore: they
   * stay on the server until removeFromServer is asked for them.
   */
  async setIgnoreGlobs(globs: string[]): Promise<NewlyIgnored> {
    assertValidIgnorePatterns(globs);
    const vaultText = await this.vaultIgnoreText();
    const before = await this.rules(await this.o.state.getIgnoreGlobs(), vaultText);
    await this.o.state.setIgnoreGlobs(globs);
    if (this.wanted && (this.phase === 'starting' || this.phase === 'running')) await this.restart();
    return newlyIgnored(this.o.state, before, await this.rules(globs, vaultText));
  }

  /** This device's ignore rules with these device globs and this .obsyncignore text. */
  private async rules(deviceGlobs: readonly string[], vaultText: string): Promise<IgnoreRules> {
    // Globs saved before validation existed could be unsupported: skip them here as the vault file does.
    const device = parseIgnoreFile(deviceGlobs.join('\n')).globs;
    return composeIgnoreRules({
      configDir: this.o.configDir, caseInsensitive: this.o.adapter.caseInsensitive, ignoreGlobs: device, vaultGlobs: parseIgnoreFile(vaultText).globs,
      settingsSync: await this.o.state.getSettingsSync(), ownPluginFolders: this.o.ownPluginFolders,
    });
  }

  /**
   * "Also remove them from the server": deletes these files on the server,
   * as if they were deleted here, while this device keeps its copies.
   * Only paths the rules still ignore when the push runs are deleted. Other
   * devices that do not ignore them move their copies to the trash.
   */
  async removeFromServer(paths: readonly string[]): Promise<void> {
    await approveServerRemoval(this.o.state, paths);
    this.running?.engine.requestSync();
  }

  /** The text of the vault's .obsyncignore ('' when there is none). */
  async vaultIgnoreText(): Promise<string> {
    const data = await this.o.adapter.read(VAULT_IGNORE_FILE);
    return data === null ? '' : new TextDecoder().decode(data);
  }

  /**
   * Saves text as the vault's .obsyncignore, the rules every device
   * applies (no file is created for empty text when there is none), and
   * asks the engine to compare everything with the new rules and push the
   * file: Obsidian reports no event for a hidden file. Lines with
   * unsupported syntax are saved too and skipped by every device; they are
   * returned in rejected. newlyIgnored: as for setIgnoreGlobs.
   */
  async setVaultIgnoreText(text: string): Promise<ParsedIgnoreFile & { newlyIgnored: NewlyIgnored }> {
    const deviceGlobs = await this.o.state.getIgnoreGlobs();
    const before = await this.rules(deviceGlobs, await this.vaultIgnoreText());
    const exists = (await this.o.adapter.stat(VAULT_IGNORE_FILE)) !== null;
    if (exists || text.trim() !== '') await this.o.adapter.write(VAULT_IGNORE_FILE, new TextEncoder().encode(text));
    this.running?.engine.requestReconcile();
    return { ...parseIgnoreFile(text), newlyIgnored: await newlyIgnored(this.o.state, before, await this.rules(deviceGlobs, text)) };
  }

  /** Stops syncing for good (until the user starts again) and forgets the account, its keys and the sync state on this device. */
  async logout(): Promise<void> {
    await this.stopForGood();
    await account.logout(this.o.state, { fetch: this.o.fetch, ...(this.o.clock ? { clock: this.o.clock } : {}) });
  }
}
