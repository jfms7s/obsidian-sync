// `obsync-cli sync`: the engine over the vault folder, once or as a daemon.
// The state is saved after every cycle that changed it (and once a minute
// at most otherwise), and on the way out.
import { readdir, readFile, realpath } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import {
  HEARTBEAT_FILE, isHeartbeatFresh, openSyncSession, parseHeartbeat, type EngineEvent, type FetchLike, type Heartbeat, type SyncEngine, type SyncStatus, type WebSocketFactory,
} from '../src/index';
import { CliError, EXIT_ERROR, EXIT_NEEDS_SETUP, EXIT_OK } from './exit';
import { FsAdapter } from './fs-adapter';
import type { Logger } from './log';
import type { PersistentState } from './state';
import { MAX_NOTICES, writeStatus, type DaemonStatus } from './status';

/** The setting that binds a state directory to one vault folder (sync --init). */
export const VAULT_DIR_SETTING = 'cli.vaultDir';
/** Most cycles `sync --once` runs to get to 'synced'. */
const ONCE_MAX_CYCLES = 10;
const SAVE_DEBOUNCE_MS = 2000;
/** How often the daemon looks at Obsidian's heartbeat. */
export const HEARTBEAT_CHECK_MS = 10_000;


const SAVE_INTERVAL_MS = 60_000;

/** Notices after which the engine has stopped for good and a person must act. */
const HALTS = new Set(['DEVICE_REVOKED', 'UNAUTHORIZED', 'VAULT_LOST']);

export interface SyncOptions {
  ps: PersistentState;
  vaultDir: string;
  once: boolean;
  init: boolean;
  trash: boolean;
  /** The vault's Obsidian configuration folder: never synced. */
  configDir: string;
  log: Logger;
  /** Resolves when the daemon is asked to stop (SIGTERM, SIGINT). */
  stop: Promise<void>;
  /** How often to look at Obsidian's heartbeat (default HEARTBEAT_CHECK_MS). */
  heartbeatCheckMs?: number;
  /** Tests: the network. */
  fetch?: FetchLike;
  webSocket?: WebSocketFactory | null;
}

const inside = (child: string, parent: string): boolean => {
  const r = relative(parent, child);
  return r === '' || (!r.startsWith(`..${sep}`) && r !== '..' && !r.startsWith(sep));
};

/**
 * The folder this state syncs. The first sync needs --init, which records
 * it; later runs refuse any other folder, so a typo in the unit file cannot
 * make the CLI upload some other folder.
 */
async function boundFolder(o: SyncOptions): Promise<string> {
  // Each of these needs a person (exit 2): restarting the unit would not help.
  let dir: string;
  try {
    dir = await realpath(o.vaultDir);
  } catch {
    throw new CliError(`the vault folder ${o.vaultDir} does not exist (a disk not mounted?)`, EXIT_NEEDS_SETUP);
  }
  const stateDir = await realpath(o.ps.dir);
  if (inside(stateDir, dir)) throw new CliError(`the state directory ${o.ps.dir} is inside the vault folder: it holds the keys and must not be synced`, EXIT_NEEDS_SETUP);
  const bound = await o.ps.state.getSetting<string | null>(VAULT_DIR_SETTING, null);
  if (bound === null) {
    if (!o.init) throw new CliError(`this state has not synced a folder yet: check that ${dir} is the vault folder, then run the first sync with --init`, EXIT_NEEDS_SETUP);
    await o.ps.state.setSetting(VAULT_DIR_SETTING, dir);
    await o.ps.save();
    o.log.info(`syncing ${dir} from now on`);
    return dir;
  }
  if (bound !== dir) throw new CliError(`this state syncs ${bound}, not ${dir}; use --name for another vault folder`, EXIT_NEEDS_SETUP);
  await checkNotEmptied(o.ps, dir);
  return dir;
}

/**
 * An empty folder where files were synced is far more likely a disk that
 * is not mounted (its mount point is an empty folder) than a vault emptied
 * on purpose; syncing it would delete those files on every device, and a
 * small vault stays under the deletion hold's threshold.
 */
async function checkNotEmptied(ps: PersistentState, dir: string): Promise<void> {
  if ((await readdir(dir)).length > 0) return;
  const synced = (await ps.state.allFiles()).filter((r) => !r.deleted && r.contentHash !== null && !r.ignored && !r.shadowed).length;
  if (synced === 0) return;
  throw new CliError(
    `${dir} is empty, but ${synced} files were synced from it: is its disk mounted? Nothing was deleted. To empty the vault on purpose, delete the files in Obsidian or on another device.`,
    EXIT_NEEDS_SETUP,
  );
}

/** What openSyncSession will refuse, said before the folder is looked at. */
async function checkSetup(ps: PersistentState): Promise<void> {
  const session = await ps.state.getSession();
  if (!session) throw new CliError('not logged in: run obsync-cli login', EXIT_NEEDS_SETUP);
  const keys = await ps.state.getUserKeys();
  if (keys?.userId !== session.userId) throw new CliError('the encryption keys are locked: run obsync-cli unlock', EXIT_NEEDS_SETUP);
  const vault = await ps.state.getVault();
  if (vault?.userId !== session.userId) throw new CliError('no vault chosen: run obsync-cli vaults, then obsync-cli vaults --choose ID', EXIT_NEEDS_SETUP);
}

/**
 * Obsidian's plugin syncing this folder right now: its heartbeat (spec D4),
 * or null when there is none or it is stale. An unreadable or damaged file
 * counts as none: the CLI must not stay paused for good over it.
 */
export async function obsidianHeartbeat(vaultDir: string, configDir: string, now = Date.now()): Promise<Heartbeat | null> {
  // The plugin keeps it in its own folder, which is usually plugins/obsync but is whatever the
  // plugin was installed as: every plugin folder is looked at, and only a heartbeat counts.
  const plugins = join(vaultDir, configDir, 'plugins');
  let folders: string[];
  try {
    folders = await readdir(plugins);
  } catch {
    return null;
  }
  for (const f of folders) {
    let text: string;
    try {
      text = await readFile(join(plugins, f, HEARTBEAT_FILE), 'utf8');
    } catch {
      continue;
    }
    const hb = parseHeartbeat(text);
    if (hb && isHeartbeatFresh(hb, now)) return hb;
  }
  return null;
}

const pausedReason = (hb: Heartbeat) => `Obsidian is syncing this folder${hb.device ? ` (device "${hb.device}")` : ''}`;

export async function runSync(o: SyncOptions): Promise<number> {
  const { ps, log } = o;
  await checkSetup(ps);
  const dir = await boundFolder(o);
  const adapter = await FsAdapter.create(dir, {
    trash: o.trash,
    unwatched: (folder) => folder === '.git' || folder === o.configDir,
    onWatchError: (err) => log.warn(`watching ${dir}: ${err.message}; changes made by other programs are found by the periodic check only`),
  });
  const session = await openSyncSession({
    state: ps.state, adapter, configDir: o.configDir, autoRun: !o.once,
    webSocket: o.once ? null : o.webSocket,
    ...(o.fetch ? { fetch: o.fetch } : {}),
  });
  if (!session.ok) {
    const why: Record<typeof session.reason, string> = {
      'not-logged-in': 'not logged in: run obsync-cli login',
      locked: 'the encryption keys are locked: run obsync-cli unlock',
      'no-vault': 'no vault chosen: run obsync-cli vaults, then obsync-cli vaults --choose ID',
      'ignores-unconfirmed': 'the vault was chosen in a setup that did not finish: run obsync-cli vaults --choose ID again',
    };
    throw new CliError(why[session.reason], EXIT_NEEDS_SETUP);
  }
  const { engine } = session;
  const daemon = new Daemon(o, dir, engine);
  return daemon.run();
}

class Daemon {
  private readonly status: DaemonStatus;
  private halted: string | null = null;
  /** Could not go on (a resume failed): the daemon ends with EXIT_ERROR. */
  private failed = false;
  private onHalt: () => void = () => undefined;
  private saveTimer: NodeJS.Timeout | null = null;
  private stopping = false;
  /** The heartbeat check in progress, so checks never overlap and shutdown can wait for one. */
  private checking: Promise<void> | null = null;
  private statusWrites: Promise<void> = Promise.resolve();

  constructor(private readonly o: SyncOptions, dir: string, private readonly engine: SyncEngine) {
    this.status = { pid: process.pid, vaultDir: dir, status: 'stopped', since: Date.now(), lastSynced: null, paused: null, notices: [] };
  }

  async run(): Promise<number> {
    const { log } = this.o;
    const halted = new Promise<void>((resolve) => (this.onHalt = resolve));
    this.engine.on((e) => this.onEvent(e));
    const hb = await obsidianHeartbeat(this.status.vaultDir, this.o.configDir);
    if (this.o.once && hb) {
      // Not a request made: Obsidian's plugin is the device syncing this folder now.
      log.info(`${pausedReason(hb)}: nothing to do`);
      return EXIT_OK;
    }
    if (hb) {
      this.status.paused = { reason: pausedReason(hb), since: Date.now() };
      log.info(`${this.status.paused.reason}: waiting until it stops`);
      await this.writeStatus();
    } else {
      await this.engine.start();
    }
    log.info(`sync started (${this.o.once ? 'once' : 'daemon'}) for ${this.status.vaultDir}`);
    if (this.o.once) {
      for (let i = 0; i < ONCE_MAX_CYCLES && this.halted === null; i++) {
        await this.engine.runCycle();
        if (this.engine.status !== 'syncing') break;
      }
    } else {
      const interval = setInterval(() => void this.save(), SAVE_INTERVAL_MS);
      const beat = setInterval(() => this.checkHeartbeat(), this.o.heartbeatCheckMs ?? HEARTBEAT_CHECK_MS);
      try {
        await Promise.race([this.o.stop, halted]);
      } finally {
        this.stopping = true;
        clearInterval(interval);
        clearInterval(beat);
        await this.checking;
      }
    }
    const final: SyncStatus = this.engine.status;
    await this.engine.stop();
    if (this.saveTimer) clearTimeout(this.saveTimer);
    const ms = await this.o.ps.save();
    log.debug(`state saved in ${ms.toFixed(0)} ms`);
    await this.writeStatus();
    if (this.halted !== null) return EXIT_NEEDS_SETUP;
    if (this.failed) return EXIT_ERROR;
    if (this.o.once) {
      log.info(`sync ${final === 'synced' ? 'done' : `ended ${final}`}`);
      return final === 'synced' ? EXIT_OK : EXIT_ERROR;
    }
    log.info('sync stopped');
    return EXIT_OK;
  }

  /** Pauses while Obsidian's plugin syncs the folder; resumes, with a full check, once it stopped. */
  private checkHeartbeat(): void {
    if (this.checking || this.stopping || this.halted !== null) return;
    this.checking = (async () => {
      const hb = await obsidianHeartbeat(this.status.vaultDir, this.o.configDir);
      if (this.stopping || this.halted !== null) return;
      if (hb && !this.status.paused) {
        this.status.paused = { reason: pausedReason(hb), since: Date.now() };
        this.o.log.info(`${this.status.paused.reason}: pausing`);
        await this.engine.stop(); // after the cycle in progress
        await this.writeStatus();
        await this.save();
      } else if (!hb && this.status.paused) {
        this.o.log.info('Obsidian stopped syncing this folder: resuming with a full check');
        try {
          await this.engine.start(); // every start begins with a reconcile
        } catch (err) {
          // The folder may be gone meanwhile (a disk unmounted): end with an error, so the
          // service manager starts the CLI again and its checks of the folder run first.
          this.o.log.error(`cannot resume: ${(err as Error).message}`);
          this.failed = true;
          this.onHalt();
          return;
        }
        this.status.paused = null;
        await this.writeStatus();
      }
    })().catch((err: unknown) => {
      this.o.log.error(`pausing or resuming for Obsidian: ${(err as Error).message}`);
    }).finally(() => {
      this.checking = null;
    });
  }

  private onEvent(e: EngineEvent): void {
    const { log } = this.o;
    switch (e.type) {
      case 'status':
        if (e.status !== this.status.status || e.detail !== this.status.detail) {
          const line = `status: ${e.status}${e.detail ? ` (${e.detail})` : ''}`;
          if (e.status === 'error' || e.status === 'offline') log.warn(line);
          else log.info(line);
        }
        this.status.status = e.status;
        if (e.detail === undefined) delete this.status.detail;
        else this.status.detail = e.detail;
        this.status.since = Date.now();
        if (e.status === 'synced') this.status.lastSynced = this.status.since;
        void this.writeStatus();
        this.scheduleSave();
        return;
      case 'notice':
        log.warn(`${e.code}: ${e.message}${e.path ? ` (${e.path})` : ''}`);
        this.status.notices = [...this.status.notices, { at: Date.now(), code: e.code, message: e.message, ...(e.path ? { path: e.path } : {}) }].slice(-MAX_NOTICES);
        void this.writeStatus();
        if (HALTS.has(e.code) && this.halted === null) {
          this.halted = e.code;
          log.error(e.code === 'VAULT_LOST' ? 'the vault is gone: choose another with obsync-cli vaults --choose' : 'this device must log in again: obsync-cli logout, then obsync-cli login');
          this.onHalt();
        }
        return;
      case 'conflict':
        log.info(`conflict: both versions kept, the other one as ${e.conflictPath}`);
        return;
      case 'merged':
        log.info(`merged edits to ${e.path}`);
        return;
      case 'remote-change':
        log.debug(`${e.action === 'delete' ? 'deleted' : 'wrote'} ${e.path}`);
        return;
    }
  }

  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.save();
    }, SAVE_DEBOUNCE_MS);
  }

  private async save(): Promise<void> {
    try {
      const ms = await this.o.ps.saveIfChanged();
      if (ms !== null) this.o.log.debug(`state saved in ${ms.toFixed(0)} ms`);
    } catch (err) {
      this.o.log.error(`cannot save the state: ${(err as Error).message}`);
    }
  }

  /** Writes the status file; writes never overlap (they share a temporary file name). */
  private writeStatus(): Promise<void> {
    const snapshot = structuredClone(this.status);
    this.statusWrites = this.statusWrites.then(async () => {
      try {
        await writeStatus(this.o.ps.dir, snapshot);
      } catch (err) {
        this.o.log.warn(`cannot write the status file: ${(err as Error).message}`);
      }
    });
    return this.statusWrites;
  }
}
