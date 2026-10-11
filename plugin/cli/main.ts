// obsync-cli: the plugin's sync engine without Obsidian (spec 2026-10-11).
// One more device on the account: log in, unlock the encryption keys,
// choose a vault, then sync a folder once or as a daemon.
import { rm } from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import { parseArgs, type ParseArgsConfig } from 'node:util';
import {
  account, ApiError, deletions, ErrorCode, InsecureServerUrlError, isAuthFailure, NetworkError, vaults, WrongPassphraseError, WrongRecoveryWordsError, InvalidRecoveryWordsError,
  type FetchLike, type WebSocketFactory,
} from '../src/index';
import { runSync, VAULT_DIR_SETTING } from './daemon';
import { CliError, EXIT_ERROR, EXIT_NEEDS_SETUP, EXIT_OK } from './exit';
import { acquireLock, lockHolder, StateLockedError } from './lock';
import type { Logger } from './log';
import { NoTerminalError, secret } from './prompt';
import { PersistentState, SNAPSHOT_FILE, StateFileError } from './state';
import { readStatus, STATUS_FILE } from './status';

declare const __OBSYNC_VERSION__: string | undefined;
export const VERSION = typeof __OBSYNC_VERSION__ === 'string' ? __OBSYNC_VERSION__ : 'dev';

export const USAGE = `obsync-cli ${VERSION}: sync an Obsidian vault folder with an obsync server, without Obsidian.

Usage: obsync-cli <command> [options]

Commands:
  login   --server URL --username NAME [--device-name NAME] [--password-fd N]
          Log this machine in as a new device. The password is read from the
          terminal, or from file descriptor N; never from an argument.
  unlock  [--recovery] [--passphrase-fd N]
          Unlock the account's encryption keys with the passphrase (or, with
          --recovery, the 24 recovery words). Set the keys up in Obsidian first.
  vaults  [--choose ID]
          List the account's vaults, or choose the one to sync.
  sync    --vault-dir DIR [--once] [--init] [--config-dir NAME] [--no-trash]
          Sync DIR, as a daemon until stopped, or one round with --once. The
          first sync of a folder needs --init; afterwards no other folder is
          accepted. --config-dir names the vault's Obsidian folder (default
          .obsidian), which is never synced. Deleted files go to DIR/.trash
          unless --no-trash.
  status  Show the account, the vault, the folder and what the daemon is doing.
  deletions [--release | --restore]
          A large local deletion is held until someone decides: list it,
          delete those files on every device (--release), or bring them back
          here (--restore).
  logout  Revoke this device on the server and delete its local state.

Options for every command:
  --name NAME        Keep this state apart from another one (another vault):
                     $XDG_STATE_HOME/obsync-cli/NAME (default: default).
  --state-dir DIR    Use DIR for the state instead.
  --verbose          Log debug lines too.
  --help, --version

Exit codes: 0 ok, 1 error, 2 a person must act (log in, unlock, choose a
vault, or check the folder: --init, or a folder missing or empty).`;

export interface Io {
  env: NodeJS.ProcessEnv;
  /** Results (stdout). */
  out(text: string): void;
  /** Usage errors (stderr; everything else goes through log). */
  err(text: string): void;
  log: (verbose: boolean) => Logger;
  /** Resolves when the process is asked to stop (SIGTERM, SIGINT). */
  stop: Promise<void>;
  /** Tests: the network (default: the global fetch and WebSocket). */
  fetch?: FetchLike;
  webSocket?: WebSocketFactory | null;
}

const GLOBAL = {
  name: { type: 'string' },
  'state-dir': { type: 'string' },
  verbose: { type: 'boolean' },
  help: { type: 'boolean' },
} as const;

const COMMANDS = {
  login: { server: { type: 'string' }, username: { type: 'string' }, 'device-name': { type: 'string' }, 'password-fd': { type: 'string' } },
  unlock: { recovery: { type: 'boolean' }, 'passphrase-fd': { type: 'string' } },
  vaults: { choose: { type: 'string' } },
  sync: { 'vault-dir': { type: 'string' }, once: { type: 'boolean' }, init: { type: 'boolean' }, 'config-dir': { type: 'string' }, 'no-trash': { type: 'boolean' } },
  status: {},
  deletions: { release: { type: 'boolean' }, restore: { type: 'boolean' } },
  logout: {},
} as const satisfies Record<string, ParseArgsConfig['options']>;

type Command = keyof typeof COMMANDS;
type Values = Record<string, string | boolean | undefined>;

/** The state directory: --state-dir, or $XDG_STATE_HOME/obsync-cli/<name>. */
export function stateDirFor(values: Values, env: NodeJS.ProcessEnv): string {
  if (typeof values['state-dir'] === 'string') return values['state-dir'];
  const name = typeof values.name === 'string' ? values.name : 'default';
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) throw new CliError(`--name ${JSON.stringify(name)}: use letters, digits, '.', '_' and '-'`);
  const base = env['XDG_STATE_HOME'] || join(env['HOME'] || homedir(), '.local', 'state');
  return join(base, 'obsync-cli', name);
}

function fd(values: Values, flag: string): number | undefined {
  const v = values[flag];
  if (v === undefined) return undefined;
  const n = Number(v);
  if (typeof v !== 'string' || !Number.isInteger(n) || n < 0) throw new CliError(`--${flag} takes a file descriptor number`);
  return n;
}

function required(values: Values, flag: string): string {
  const v = values[flag];
  if (typeof v !== 'string' || v === '') throw new CliError(`--${flag} is required`);
  return v;
}

/** Runs one command; resolves with the exit code. */
export async function run(argv: string[], io: Io): Promise<number> {
  const [first, ...rest] = argv;
  if (first === undefined) {
    io.err(`${USAGE}\n`);
    return EXIT_ERROR;
  }
  if (first === '--help' || first === '-h' || first === 'help') {
    io.out(`${USAGE}\n`);
    return EXIT_OK;
  }
  if (first === '--version') {
    io.out(`${VERSION}\n`);
    return EXIT_OK;
  }
  if (!(first in COMMANDS)) {
    io.err(`unknown command ${JSON.stringify(first)}\n\n${USAGE}\n`);
    return EXIT_ERROR;
  }
  const command = first as Command;
  let values: Values;
  try {
    values = parseArgs({ args: rest, options: { ...GLOBAL, ...COMMANDS[command] }, strict: true, allowPositionals: false }).values as Values;
  } catch (err) {
    io.err(`${(err as Error).message}\n\n${USAGE}\n`);
    return EXIT_ERROR;
  }
  if (values.help) {
    io.out(`${USAGE}\n`);
    return EXIT_OK;
  }
  const log = io.log(values.verbose === true);
  try {
    return await dispatch(command, values, io, log);
  } catch (err) {
    log.error(describe(err));
    return err instanceof CliError ? err.exitCode : isAuthFailure(err) ? EXIT_NEEDS_SETUP : EXIT_ERROR;
  }
}

function describe(err: unknown): string {
  if (err instanceof CliError || err instanceof StateLockedError || err instanceof StateFileError || err instanceof InsecureServerUrlError || err instanceof NoTerminalError) return err.message;
  if (isAuthFailure(err)) return `the server refused this device (${(err as Error).message}): obsync-cli logout, then obsync-cli login`;
  if (err instanceof NetworkError) return `cannot reach the server: ${err.message}`;
  if (err instanceof ApiError) return `the server said: ${err.message}`;
  return err instanceof Error ? (err.stack ?? err.message) : String(err);
}

async function dispatch(command: Command, values: Values, io: Io, log: Logger): Promise<number> {
  const dir = stateDirFor(values, io.env);
  if (command === 'status') return status(dir, io);
  if (command === 'vaults' && values.choose === undefined) return withState(dir, (ps) => listVaults(ps, io));
  if (command === 'deletions' && !values.release && !values.restore) return withState(dir, (ps) => listHeld(ps, io));
  // Everything else changes the state: one process at a time.
  const release = await acquireLock(await ensureDir(dir));
  try {
    switch (command) {
      case 'login':
        return await withState(dir, (ps) => login(ps, values, io, log));
      case 'unlock':
        return await withState(dir, (ps) => unlock(ps, values, io, log));
      case 'vaults':
        return await withState(dir, (ps) => chooseVault(ps, values.choose as string, io, log));
      case 'deletions':
        return await withState(dir, (ps) => decideHeld(ps, values, io, log));
      case 'logout':
        return await logout(dir, io, log);
      case 'sync':
        return await withState(dir, (ps) => runSync({
          ps, log, stop: io.stop,
          vaultDir: required(values, 'vault-dir'),
          once: values.once === true,
          init: values.init === true,
          trash: values['no-trash'] !== true,
          configDir: typeof values['config-dir'] === 'string' ? values['config-dir'] : '.obsidian',
          ...(io.fetch ? { fetch: io.fetch } : {}),
          ...(io.webSocket !== undefined ? { webSocket: io.webSocket } : {}),
        }));
    }
  } finally {
    await release();
  }
}

async function ensureDir(dir: string): Promise<string> {
  await (await PersistentState.open(dir)).close(); // creates it, mode 0700
  return dir;
}

async function withState<T>(dir: string, fn: (ps: PersistentState) => Promise<T>): Promise<T> {
  const ps = await PersistentState.open(dir);
  try {
    return await fn(ps);
  } finally {
    await ps.close();
  }
}

const deps = (io: Io): account.ClientDeps => (io.fetch ? { fetch: io.fetch } : {});

async function needSession(ps: PersistentState) {
  const session = await ps.state.getSession();
  if (!session) throw new CliError('not logged in: run obsync-cli login', EXIT_NEEDS_SETUP);
  return session;
}

async function needKeys(ps: PersistentState) {
  const session = await needSession(ps);
  const keys = await account.loadUserKeys(ps.state, session.userId);
  if (!keys) throw new CliError('the encryption keys are locked: run obsync-cli unlock', EXIT_NEEDS_SETUP);
  return { session, keys };
}

// ----- commands -----

async function login(ps: PersistentState, values: Values, io: Io, log: Logger): Promise<number> {
  const existing = await ps.state.getSession();
  if (existing) throw new CliError(`already logged in as ${existing.username} on ${existing.serverUrl}; run obsync-cli logout first`);
  const server = required(values, 'server');
  const username = required(values, 'username');
  const deviceName = typeof values['device-name'] === 'string' ? values['device-name'] : `obsync-cli on ${hostname()}`;
  const password = await secret(fd(values, 'password-fd'), `Password for ${username}: `, 'the password', '--password-fd');
  let session;
  try {
    session = await account.login(ps.state, server, username, password, deviceName, `cli-${process.platform}`, deps(io));
  } catch (err) {
    if (err instanceof ApiError && (err.code === ErrorCode.UNAUTHORIZED || err.code === ErrorCode.WRONG_PASSWORD)) throw new CliError('wrong username or password');
    throw err;
  }
  await ps.save();
  log.info(`logged in to ${session.serverUrl} as ${username}, device "${deviceName}"`);
  const st = await account.keyStatus(ps.state, account.apiFor(session, deps(io)), session);
  await ps.save();
  io.out(st === 'unlocked' ? 'Next: obsync-cli vaults\n' : st === 'needs-unlock' ? 'Next: obsync-cli unlock\n' : `${noKeysHint(st)}\n`);
  return EXIT_OK;
}

function noKeysHint(st: account.KeyStatus): string {
  return st === 'needs-setup'
    ? 'This account has no encryption keys yet: set them up in Obsidian (Obsync settings) on your first device, then run obsync-cli unlock.'
    : 'The server has lost this account\'s key bundle: upload it again from Obsidian (Obsync settings), then run obsync-cli unlock.';
}

async function unlock(ps: PersistentState, values: Values, io: Io, log: Logger): Promise<number> {
  const session = await needSession(ps);
  const api = account.apiFor(session, deps(io));
  const st = await account.keyStatus(ps.state, api, session);
  await ps.save();
  if (st === 'unlocked') {
    io.out('Already unlocked. Next: obsync-cli vaults\n');
    return EXIT_OK;
  }
  if (st !== 'needs-unlock') throw new CliError(noKeysHint(st));
  const recovery = values.recovery === true;
  const input = await secret(
    fd(values, 'passphrase-fd'),
    recovery ? 'Recovery words: ' : 'Encryption passphrase: ',
    recovery ? 'the recovery words' : 'the passphrase', '--passphrase-fd',
  );
  try {
    if (recovery) await account.unlockWithRecoveryService(ps.state, api, session, input);
    else await account.unlockWithPassphraseService(ps.state, api, session, input);
  } catch (err) {
    if (err instanceof WrongPassphraseError) throw new CliError('wrong passphrase');
    if (err instanceof WrongRecoveryWordsError || err instanceof InvalidRecoveryWordsError) throw new CliError(err.message);
    throw err;
  }
  await ps.save();
  log.info('unlocked');
  io.out('Next: obsync-cli vaults\n');
  return EXIT_OK;
}

async function listVaults(ps: PersistentState, io: Io): Promise<number> {
  const { session, keys } = await needKeys(ps);
  const chosen = await ps.state.getVault();
  const list = await vaults.listRemoteVaults(account.apiFor(session, deps(io)), session, keys);
  if (list.length === 0) {
    io.out('No vaults yet: create one in Obsidian (Obsync settings).\n');
    return EXIT_OK;
  }
  for (const v of list) {
    const mark = chosen?.vaultId === v.vaultId && chosen.userId === session.userId ? '*' : ' ';
    io.out(`${mark} ${v.vaultId}  ${v.name ?? '(name cannot be read)'}${v.owned ? '' : '  (shared with you)'}\n`);
  }
  if (!chosen) io.out('Choose one: obsync-cli vaults --choose ID\n');
  return EXIT_OK;
}

async function chooseVault(ps: PersistentState, id: string, io: Io, log: Logger): Promise<number> {
  const { session, keys } = await needKeys(ps);
  const previous = await ps.state.getVault();
  const v = await vaults.chooseVault(ps.state, account.apiFor(session, deps(io)), session, keys, id);
  // Another vault is another folder: the next sync needs --init again.
  if (previous?.vaultId !== v.vaultId) await ps.state.setSetting(VAULT_DIR_SETTING, null);
  await ps.save();
  log.info(`vault "${v.name}" chosen`);
  io.out('Next: obsync-cli sync --vault-dir DIR --init (once), then run it as a service\n');
  return EXIT_OK;
}

async function listHeld(ps: PersistentState, io: Io): Promise<number> {
  const held = await deletions.heldDeletions(ps.state);
  if (held.length === 0) {
    io.out('No deletions are on hold.\n');
    return EXIT_OK;
  }
  io.out(`${held.length} files deleted in this folder are on hold (not deleted on other devices yet):\n`);
  for (const p of held) io.out(`  ${p}\n`);
  io.out('Delete them everywhere: obsync-cli deletions --release\nBring them back here: obsync-cli deletions --restore\n');
  return EXIT_OK;
}

async function decideHeld(ps: PersistentState, values: Values, io: Io, log: Logger): Promise<number> {
  if (values.release && values.restore) throw new CliError('choose one of --release and --restore');
  const n = values.release ? await deletions.releaseHeldDeletions(ps.state) : await deletions.restoreHeldDeletions(ps.state);
  await ps.save();
  log.info(values.release ? `${n} deletions released: the next sync deletes them on every device` : `${n} files will be restored by the next sync`);
  io.out(n === 0 ? 'No deletions were on hold.\n' : 'Done; it takes effect at the next sync (start or restart the daemon).\n');
  return EXIT_OK;
}

async function logout(dir: string, io: Io, log: Logger): Promise<number> {
  await withState(dir, async (ps) => {
    const session = await ps.state.getSession();
    if (!session) {
      io.out('Not logged in.\n');
      return;
    }
    try {
      await account.apiFor(session, deps(io)).logout(); // revokes this device
    } catch (err) {
      log.warn(`could not revoke this device on the server (${(err as Error).message}); revoke "${session.deviceName}" from another device`);
    }
  });
  for (const f of [SNAPSHOT_FILE, STATUS_FILE]) await rm(join(dir, f), { force: true });
  log.info('logged out; the local state is deleted');
  return EXIT_OK;
}

async function status(dir: string, io: Io): Promise<number> {
  const ps = await PersistentState.open(dir);
  try {
    const st = ps.state;
    const session = await st.getSession();
    const line = (k: string, v: string) => io.out(`${`${k}:`.padEnd(9)} ${v}\n`);
    line('state', dir);
    if (!session) {
      line('account', 'not logged in (obsync-cli login)');
      return EXIT_NEEDS_SETUP;
    }
    line('server', session.serverUrl);
    line('account', `${session.username}, device "${session.deviceName}"`);
    const keys = await account.loadUserKeys(st, session.userId);
    line('keys', keys ? 'unlocked' : 'locked (obsync-cli unlock)');
    const vault = await st.getVault();
    line('vault', vault && vault.userId === session.userId ? `${vault.name} (${vault.vaultId})` : 'none chosen (obsync-cli vaults)');
    const folder = await st.getSetting<string | null>(VAULT_DIR_SETTING, null);
    line('folder', folder ?? 'none yet (obsync-cli sync --vault-dir DIR --init)');
    const pid = await lockHolder(dir);
    const d = await readStatus(dir);
    if (pid !== null && d?.pid === pid) {
      const paused = d.paused ? `, paused since ${new Date(d.paused.since).toISOString()}: ${d.paused.reason}` : '';
      line('daemon', `running (pid ${pid}), ${d.status}${d.detail ? ` (${d.detail})` : ''}${paused}`);
    } else {
      line('daemon', pid !== null ? `pid ${pid} holds the state` : 'not running');
    }
    if (d?.lastSynced) line('synced', new Date(d.lastSynced).toISOString());
    // The numbers below are from the last saved state (the daemon saves after each cycle).
    const dirty = (await st.dirtyEntries()).length;
    const pending = (await st.allPending()).length;
    const failures = await st.allFailures();
    line('waiting', `${dirty} changed here, ${pending} commits unconfirmed, ${failures.length} failed files`);
    for (const f of failures.slice(0, 10)) io.out(`  ${f.key}: ${f.message}\n`);
    const held = await deletions.heldDeletions(st);
    if (held.length > 0) line('held', `${held.length} deletions on hold (obsync-cli deletions)`);
    for (const n of d?.notices.slice(-5) ?? []) io.out(`  ${new Date(n.at).toISOString()} ${n.code}: ${n.message}${n.path ? ` (${n.path})` : ''}\n`);
    return keys && vault ? EXIT_OK : EXIT_NEEDS_SETUP;
  } finally {
    await ps.close();
  }
}
