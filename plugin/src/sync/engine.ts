// The sync engine for one vault on one device. All work runs in a single
// serialized loop ("cycle"): pull, reconcile when due, then push rounds
// until nothing is dirty. Triggers (local events, hub notifications,
// timers, reconnects) only set flags and schedule a cycle, so no two pieces
// of sync logic ever touch local state at the same time.
import type { ApiClient } from '../api/client';
import { ApiError, ErrorCode, isAuthFailure, isTemporary, isVaultNotFound, NetworkError } from '../api/errors';
import { HubClient, type WebSocketFactory } from '../api/hub';
import { hubUrl } from '../api/url';
import { fileIdFor } from '../crypto/objects';
import { MissingEpochKeyError, type VaultKeyring } from '../crypto/vaultkeys';
import type { LocalState } from '../state/store';
import { backoffDelay, DEFAULT_BACKOFF, type BackoffPolicy } from '../util/backoff';
import { systemClock, type Clock, type TimerHandle } from '../util/clock';
import { toHex } from '../util/bytes';
import { errorMessage } from '../util/errors';
import { cryptoRandom, type Random } from '../util/random';
import type { AdapterEvent, VaultAdapter } from '../vault/adapter';
import { ConfigCarveOut, SETTINGS_SYNC_OFF, settingsFilePaths, type SettingsSyncPolicy } from '../vault/config-policy';
import { IgnoreRules, parseIgnoreFile, VAULT_IGNORE_FILE, type ParsedIgnoreFile } from '../vault/ignore';
import { DEFAULT_MAX_FILE_BYTES, ServerRollbackError, type SyncContext } from './context';
import { pathOfPushKey } from '../state/failure-keys';
import { isSyncedHere } from './local';
import { isCycleError, nextRetryAt } from './failures';
import type { EngineEvent, EngineListener, SyncStatus } from './events';
import { applyVaultIgnoreFirst, pull } from './pull';
import { PushMemory, pushRound } from './push';
import { reconcile } from './reconcile';
import type { RestartBase } from './settings-files';

export const RECONCILE_INTERVAL_MS = 15 * 60_000;
/** How often the settings files the policy syncs are looked at: Obsidian reports no event for the config folder (spec D5). */
export const SETTINGS_POLL_MS = 30_000;
/** Local changes are synced once they pause this long... */
export const DEBOUNCE_MS = 500;
/** ...or at the latest this long after the first of them, so steady typing still syncs. */
export const DEBOUNCE_MAX_WAIT_MS = 5000;
const MAX_PUSH_ROUNDS_PER_CYCLE = 20;
/** The setting holding the .obsyncignore text last noticed for skipped lines. */
const NOTICED_IGNORE_TEXT = 'vaultIgnoreNoticed';

export interface EngineOptions {
  api: ApiClient;
  state: LocalState;
  adapter: VaultAdapter;
  ring: VaultKeyring;
  deviceName: string;
  clock?: Clock;
  random?: Random;
  /**
   * The vault's configuration folder (Vault.configDir, usually .obsidian).
   * The engine never syncs it, whatever ignoreGlobs say: it holds this
   * device's own settings and plugins, this one's code among them. The
   * only exception is settingsSync.
   */
  configDir: string;
  /** Which settings files in configDir this device syncs (config-policy.ts); default SETTINGS_SYNC_OFF. */
  settingsSync?: SettingsSyncPolicy;
  /** The folder name(s) of this plugin under plugins/ when not OBSYNC_PLUGIN_ID: never synced. */
  ownPluginFolders?: readonly string[];
  /**
   * SyncContext.restartBases: pass one map for the plugin's lifetime (the
   * shell does), so it outlives engine restarts and is gone when Obsidian
   * restarts. Default: a map of this engine's own.
   */
  restartBases?: Map<string, RestartBase>;
  /** How often to look at the settings files the policy syncs (default SETTINGS_POLL_MS); with autoRun only. */
  settingsPollMs?: number;
  /**
   * The user's ignore patterns (gitignore-like globs), on top of the
   * defaults, the config folder and the vault's .obsyncignore (which the
   * engine reads itself). Throws InvalidIgnorePatternError for unsupported syntax.
   */
  ignoreGlobs?: readonly string[];
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
  debounceMaxWaitMs?: number;
  /** Default 256 MiB (DEFAULT_MAX_FILE_BYTES): larger files are neither uploaded nor downloaded. */
  maxFileBytes?: number;
  /** Bytes of file content one push round takes on at most (default MAX_BYTES_PER_ROUND, 64 MiB). */
  maxBytesPerRound?: number;
  /**
   * Fetches the vault's keys again: after STALE_EPOCH, or when a version uses
   * an epoch this device has no key for (sub-project 3). Without it, such a
   * cycle fails and is retried with backoff.
   */
  refreshKeyring?: () => Promise<VaultKeyring>;
}

/**
 * The ignore rules an engine with these options applies: the defaults, the
 * config folder, the vault's .obsyncignore globs and the device's own. The
 * one place they are composed; the settings use it to tell what a change
 * of either list newly ignores.
 */
export function composeIgnoreRules(o: {
  configDir: string;
  caseInsensitive: boolean;
  ignoreGlobs: readonly string[];
  vaultGlobs: readonly string[];
  settingsSync?: SettingsSyncPolicy | undefined;
  ownPluginFolders?: readonly string[] | undefined;
}): IgnoreRules {
  return new IgnoreRules(o.ignoreGlobs, {
    caseInsensitive: o.caseInsensitive, configDir: o.configDir, vaultGlobs: o.vaultGlobs,
    configSync: new ConfigCarveOut(o.configDir, o.settingsSync ?? SETTINGS_SYNC_OFF, o.ownPluginFolders ?? []),
  });
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
  private timerIsDebounce = false;
  /** When the first local event since the last cycle began arrived (null: none). */
  private debounceStart: number | null = null;
  private reconcileTimer: TimerHandle | null = null;
  private settingsTimer: TimerHandle | null = null;
  /** The settings files the policy syncs (settingsFilePaths): polled, since no event reports them. */
  private readonly settingsFiles: readonly string[];
  private applyRetryTimer: TimerHandle | null = null;
  private applyRetryAt = Infinity;

  private reconcileDue = true;
  /** Reconciles started so far; compared with hubDownAt to tell whether one began after the hub lost its connection. */
  private reconcilesStarted = 0;
  /** reconcilesStarted when the hub was last without a connection (at start, or when its connection closed). */
  private hubDownAt = 0;
  /** Some file is not written locally because another file or a folder holds its name; freeing that name must re-check it. */
  private hasShadowed = false;
  /** The newest vault seq known: from the last pull, raised by hub notifications. */
  private knownSeq = 0;
  /** The highest seq notified since the last pull began. */
  private notifiedSeq = 0;
  private eventWrites: Promise<unknown> = Promise.resolve();
  /** Epochs the last keyring refresh lacked (SyncContext.unavailableEpochs); checked again with each reconcile interval. */
  private readonly unavailableEpochs = new Set<number>();
  /** The text of the vault's .obsyncignore as last read (null: no such file; undefined: not read yet). */
  private vaultIgnoreText: string | null | undefined = undefined;
  private vaultIgnore: ParsedIgnoreFile = { globs: [], rejected: [] };
  /** The server's .obsyncignore was looked for before this engine's first pull (a device that never pulled). */
  private vaultIgnoreFetched = false;
  /** Settings files from other devices written in this cycle, and by which devices: one notice at its end. */
  private settingsApplied = { files: 0, devices: new Set<string>() };

  constructor(private readonly opts: EngineOptions) {
    if (opts.configDir.replace(/\//g, '') === '') throw new RangeError('the vault\'s config folder must be named');
    this.clock = opts.clock ?? systemClock;
    this.random = opts.random ?? cryptoRandom;
    this.autoRun = opts.autoRun ?? true;
    this.settingsFiles = settingsFilePaths(opts.configDir, opts.settingsSync ?? SETTINGS_SYNC_OFF, opts.ownPluginFolders ?? []);
    this.ctx = {
      api: opts.api,
      state: opts.state,
      adapter: opts.adapter,
      ring: opts.ring,
      deviceName: opts.deviceName,
      clock: this.clock,
      random: this.random,
      ignore: this.buildRules(),
      maxFileBytes: opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
      ...(opts.maxBytesPerRound !== undefined ? { maxBytesPerRound: opts.maxBytesPerRound } : {}),
      unavailableEpochs: this.unavailableEpochs,
      emit: (e) => this.emit(e),
      onShadowed: () => {
        this.hasShadowed = true;
      },
      reloadVaultIgnore: () => this.loadVaultIgnore(),
      restartBases: opts.restartBases ?? new Map(),
      onSettingsApplied: (_path, device) => {
        this.settingsApplied.files++;
        if (device) this.settingsApplied.devices.add(device);
      },
    };
  }

  /** The vault's .obsyncignore as last read: its rules, and the lines skipped for unsupported syntax. */
  get vaultIgnoreFile(): ParsedIgnoreFile {
    return this.vaultIgnore;
  }

  private buildRules(): IgnoreRules {
    const o = this.opts;
    return composeIgnoreRules({
      configDir: o.configDir, caseInsensitive: o.adapter.caseInsensitive, ignoreGlobs: o.ignoreGlobs ?? [], vaultGlobs: this.vaultIgnore.globs,
      settingsSync: o.settingsSync, ownPluginFolders: o.ownPluginFolders,
    });
  }

  /**
   * Reads the vault's .obsyncignore and, when it changed, rebuilds the
   * rules and asks for a reconcile: files it no longer matches are applied
   * or pushed then, and the file itself is found even where the platform
   * sends no event for a hidden file. Called at the start of each cycle
   * and right after pull applied a version of it, so a rule never applies
   * half-way through one file. An unreadable file keeps the rules as they were.
   */
  private async loadVaultIgnore(): Promise<void> {
    let data: Uint8Array | null;
    try {
      data = await this.opts.adapter.read(VAULT_IGNORE_FILE);
    } catch (err) {
      if (isCycleError(err)) throw err;
      return;
    }
    const text = data === null ? null : new TextDecoder().decode(data);
    if (text === this.vaultIgnoreText) return;
    const first = this.vaultIgnoreText === undefined;
    this.vaultIgnoreText = text;
    this.vaultIgnore = parseIgnoreFile(text ?? '');
    this.ctx.ignore = this.buildRules();
    if (!first) {
      this.reconcileDue = true;
      this.schedule(0);
    }
    await this.noticeSkippedLines(text);
  }

  /** One notice per change of the file while it has lines that were skipped (the settings tab lists them). */
  private async noticeSkippedLines(text: string | null): Promise<void> {
    const count = this.vaultIgnore.rejected.length;
    if (count === 0 || text === null) return;
    if ((await this.ctx.state.getSetting<string | null>(NOTICED_IGNORE_TEXT, null)) === text) return;
    await this.ctx.state.setSetting(NOTICED_IGNORE_TEXT, text);
    this.emit({
      type: 'notice', code: 'IGNORE_LINES_SKIPPED', persistent: false, path: VAULT_IGNORE_FILE, count,
      message: `${count} line(s) of ${VAULT_IGNORE_FILE} use unsupported syntax and were skipped`,
    });
  }

  /**
   * Before every cycle: the vault's .obsyncignore as it is on disk now and,
   * on a device that never pulled, as the server has it, before anything else arrives.
   */
  private async prepareVaultIgnore(): Promise<void> {
    this.ctx.vaultIgnoreFileId ??= toHex(await fileIdFor(this.ctx.ring.namingKey, VAULT_IGNORE_FILE));
    await this.loadVaultIgnore();
    if (this.vaultIgnoreFetched) return;
    if ((await this.ctx.state.getCursor()) === 0) await applyVaultIgnoreFirst(this.ctx);
    this.vaultIgnoreFetched = true;
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
    // Watching first: if it throws, the engine is still stopped and a later start() tries again.
    this.unwatch = this.opts.adapter.watch((ev) => this.onAdapterEvent(ev));
    this.stopped = false;
    this.reconcileDue = true;
    this.setStatus('syncing');
    this.hubDownAt = this.reconcilesStarted;
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
            // Notifications may have been missed while there was no
            // connection; a reconcile that began since then (the one at
            // start, usually) already covers them, and the pull that every
            // cycle begins with covers the time up to the subscribe.
            if (this.reconcilesStarted === this.hubDownAt) this.reconcileDue = true;
            this.schedule(0);
          },
          onDisconnected: () => {
            this.hubDownAt = this.reconcilesStarted;
          },
          onAuthFailure: (code, message) => this.halt(code === ErrorCode.DEVICE_REVOKED ? 'DEVICE_REVOKED' : 'UNAUTHORIZED', message),
          onVaultNotFound: () => void this.checkVaultAccess(),
        },
      );
      this.hub.start();
    }
    if (this.autoRun) {
      this.scheduleReconcile();
      this.scheduleSettingsPoll();
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
    if (this.settingsTimer) this.clock.clearTimeout(this.settingsTimer);
    this.timer = this.reconcileTimer = this.applyRetryTimer = this.settingsTimer = null;
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
   * The hub's VAULT_NOT_FOUND frame names no vault, so confirm over HTTP
   * before giving up: only a lost-vault answer for this vault's keys means
   * access is gone.
   */
  private async checkVaultAccess(): Promise<void> {
    try {
      await this.opts.api.vaultKeys(this.ctx.ring.vaultId);
    } catch (err) {
      if (isVaultNotFound(err)) {
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
    // A name was freed: a shadowed file may be able to take it now.
    if (this.hasShadowed && (ev.type === 'delete' || ev.type === 'rename')) this.reconcileDue = true;
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
      .catch(() => {
        // Not recorded (the database failed): a reconcile finds the change instead of the 15-minute one.
        this.reconcileDue = true;
        this.schedule(0);
      });
    this.debounce();
  }

  /**
   * A cycle once local events pause for debounceMs, but no later than
   * debounceMaxWaitMs after the first event since the last cycle began.
   * An earlier cycle that is already scheduled (not a debounce) stays.
   */
  private debounce(): void {
    if (!this.autoRun || this.stopped) return;
    const now = this.clock.now();
    this.debounceStart ??= now;
    const at = Math.min(now + (this.opts.debounceMs ?? DEBOUNCE_MS), this.debounceStart + (this.opts.debounceMaxWaitMs ?? DEBOUNCE_MAX_WAIT_MS));
    if (this.timer && !this.timerIsDebounce && this.timerAt <= at) return;
    this.setTimer(at, true);
  }

  private schedule(delayMs: number): void {
    if (!this.autoRun || this.stopped) return;
    const at = this.clock.now() + delayMs;
    if (this.timer && this.timerAt <= at) return;
    this.setTimer(at, false);
  }

  private setTimer(at: number, debounce: boolean): void {
    if (this.timer) this.clock.clearTimeout(this.timer);
    this.timerAt = at;
    this.timerIsDebounce = debounce;
    this.timer = this.clock.setTimeout(() => {
      this.timer = null;
      this.timerAt = Infinity;
      void this.runCycle();
    }, Math.max(0, at - this.clock.now()));
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

  private scheduleSettingsPoll(): void {
    if (this.settingsFiles.length === 0 || this.stopped) return;
    this.settingsTimer = this.clock.setTimeout(() => {
      this.settingsTimer = null;
      void this.pollSettings()
        .catch(() => undefined) // the database failed: the next poll, or the reconcile, tries again
        .finally(() => this.scheduleSettingsPoll());
    }, this.opts.settingsPollMs ?? SETTINGS_POLL_MS);
  }

  /**
   * Looks at each settings file the policy syncs (a stat each) and queues
   * the ones that differ from what was last synced in size or mtime, or
   * appeared or disappeared, for the next cycle. Returns how many. Records
   * of files this device did not write (still ignored, say) are left to reconcile.
   */
  async pollSettings(): Promise<number> {
    let changed = 0;
    for (const path of this.settingsFiles) {
      if (this.ctx.ignore.matches(path)) continue; // another rule ignores it here
      let st: Awaited<ReturnType<VaultAdapter['stat']>>;
      try {
        st = await this.opts.adapter.stat(path);
      } catch {
        continue; // unreadable now: push reports it once it is queued another way
      }
      const rec = (await this.ctx.state.filesByPath(path)).find((r) => r.path === path);
      const synced = isSyncedHere(rec);
      const differs = st
        ? (!rec || (synced && (rec.deleted || st.mtime !== rec.localMtime || st.size !== rec.size)))
        : synced && !rec.deleted;
      if (!differs) continue;
      await this.ctx.state.markDirty(path);
      changed++;
    }
    if (changed > 0) this.debounce();
    return changed;
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
    try {
      await this.cycleBody();
    } finally {
      this.noticeSettingsApplied();
    }
  }

  /** Obsidian reads its settings files at start: one notice per cycle that wrote any. */
  private noticeSettingsApplied(): void {
    const { files, devices } = this.settingsApplied;
    if (files === 0) return;
    this.settingsApplied = { files: 0, devices: new Set() };
    const from = [...devices].sort();
    this.emit({
      type: 'notice', code: 'SETTINGS_APPLIED', persistent: false, count: files, devices: from,
      message: `${files} Obsidian settings file(s) from ${from.join(', ') || 'another device'} were written; restart Obsidian to use them`,
    });
  }

  private async cycleBody(): Promise<void> {
    this.debounceStart = null; // this cycle takes every event so far
    await this.eventWrites;
    this.setStatus('syncing');
    try {
      // The server's seq replaces what was known (it can go down after a
      // restore from a backup); only notifications that arrived during the
      // pull may be ahead of it.
      this.notifiedSeq = 0;
      await this.prepareVaultIgnore();
      if (this.reconcileDue) {
        // Cleared first so a request during the reconcile is kept, and set
        // again if it fails, so the retry reconciles too.
        this.reconcileDue = false;
        this.reconcilesStarted++;
        let r: Awaited<ReturnType<typeof reconcile>>;
        try {
          r = await reconcile(this.ctx);
        } catch (err) {
          this.reconcileDue = true;
          throw err;
        }
        this.knownSeq = Math.max(r.vaultSeq, this.notifiedSeq);
        this.hasShadowed = r.shadowed > 0;
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
      const waiting = new Set(failures.flatMap((f) => pathOfPushKey(f.key) ?? []));
      const dirty = (await this.ctx.state.dirtyEntries()).filter((e) => !waiting.has(e.path)).length;
      const cursor = await this.ctx.state.getCursor();
      this.setStatus(dirty === 0 && cursor >= this.knownSeq ? 'synced' : 'syncing');
      if (cursor < this.knownSeq) this.schedule(0);
      // Local files are retried by push, remote versions by reconcile:
      // that one is asked for only when the earliest retry is due, so
      // cycles before then (local edits, notifications) stay cheap.
      const pushRetryAt = nextRetryAt(failures, 'push');
      if (pushRetryAt !== null) this.schedule(Math.max(0, pushRetryAt - this.clock.now()));
      const applyRetryAt = nextRetryAt(failures, 'apply');
      if (applyRetryAt !== null) this.scheduleApplyRetry(applyRetryAt);
    } catch (err) {
      try {
        await this.onCycleError(err);
      } catch (handlingErr) {
        // Handling failed too (e.g. IndexedDB while forgetting synced
        // versions): back off and try the whole cycle again.
        this.setStatus('error', errorMessage(handlingErr));
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
    else this.setStatus('error', isTemporary(err) ? `retrying: ${errorMessage(err)}` : errorMessage(err));
    this.schedule(delay);
  }
}
