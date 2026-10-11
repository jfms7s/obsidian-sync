// obsync-cli's command line, in process: arguments, help, the state
// directory, and the commands that need no server.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { build } from 'esbuild';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cliOptions } from '../../esbuild.config.mjs';
import { CliError } from '../../cli/exit';
import { acquireLock, StateLockedError } from '../../cli/lock';
import { streamLogger } from '../../cli/log';
import { run, stateDirFor, USAGE, type Io } from '../../cli/main';

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
async function temp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'obsync-cli-'));
  dirs.push(d);
  return d;
}

function io(env: NodeJS.ProcessEnv = {}) {
  const r = { out: '', err: '', log: '' };
  const value: Io = {
    env, out: (t) => (r.out += t), err: (t) => (r.err += t), log: (v) => streamLogger((l) => (r.log += l), v), stop: new Promise(() => undefined),
  };
  return { io: value, r };
}

describe('obsync-cli arguments', () => {
  it('prints help on --help (exit 0) and on nothing at all (exit 1, to stderr)', async () => {
    const a = io();
    expect(await run(['--help'], a.io)).toBe(0);
    expect(a.r.out).toContain('Usage: obsync-cli <command>');
    const b = io();
    expect(await run([], b.io)).toBe(1);
    expect(b.r.err).toContain(USAGE);
    expect(b.r.out).toBe('');
  });

  it('refuses unknown commands and options, and secrets given as arguments', async () => {
    const a = io();
    expect(await run(['frobnicate'], a.io)).toBe(1);
    expect(a.r.err).toMatch(/unknown command "frobnicate"/);
    const b = io();
    expect(await run(['login', '--password', 'hunter2'], b.io)).toBe(1);
    expect(b.r.err).toMatch(/Unknown option '--password'/);
    const c = io();
    expect(await run(['status', 'extra'], c.io)).toBe(1);
  });

  it('keeps the state under $XDG_STATE_HOME/obsync-cli/<name>, or where --state-dir says', () => {
    expect(stateDirFor({}, { XDG_STATE_HOME: '/x/state', HOME: '/home/u' })).toBe('/x/state/obsync-cli/default');
    expect(stateDirFor({ name: 'work' }, { HOME: '/home/u' })).toBe('/home/u/.local/state/obsync-cli/work');
    expect(stateDirFor({ 'state-dir': '/elsewhere', name: 'ignored' }, {})).toBe('/elsewhere');
    expect(() => stateDirFor({ name: '../up' }, {})).toThrow(CliError);
    expect(() => stateDirFor({ name: '.hidden' }, {})).toThrow(CliError);
  });

  it('says what is missing with exit code 2', async () => {
    const dir = await temp();
    const a = io();
    expect(await run(['status', '--state-dir', dir], a.io)).toBe(2);
    expect(a.r.out).toMatch(/not logged in/);
    const b = io();
    expect(await run(['unlock', '--state-dir', dir], b.io)).toBe(2);
    expect(b.r.log).toMatch(/error: not logged in/);
    const c = io();
    expect(await run(['deletions', '--state-dir', dir], c.io)).toBe(0);
    expect(c.r.out).toMatch(/No deletions are on hold/);
  });

  it('refuses a state-changing command while another process holds the state', async () => {
    const dir = await temp();
    // Another live process holds it: the lock file names our parent.
    await writeFile(join(dir, 'lock'), `${process.ppid}\n`);
    await expect(acquireLock(dir)).rejects.toThrow(StateLockedError);
    const a = io();
    expect(await run(['logout', '--state-dir', dir], a.io)).toBe(1);
    expect(a.r.log).toMatch(/another obsync-cli \(pid \d+\)/);
    // A lock whose process is gone is taken over.
    await writeFile(join(dir, 'lock'), '999999999\n');
    const again = await acquireLock(dir);
    expect((await readFile(join(dir, 'lock'), 'utf8')).trim()).toBe(String(process.pid));
    await again();
  });
});

describe('the obsync-cli bundle', () => {
  let work: string;
  let bundle: string;
  beforeAll(async () => {
    work = await mkdtemp(join(tmpdir(), 'obsync-cli-bundle-'));
    bundle = join(work, 'obsync-cli.mjs');
    await build({ ...cliOptions(), outfile: bundle, logLevel: 'silent' });
  });
  afterAll(() => rm(work, { recursive: true, force: true }));

  it('runs under Node with nothing installed next to it', async () => {
    const manifest = JSON.parse(await readFile(new URL('../../../manifest.json', import.meta.url), 'utf8')) as { version: string };
    const version = spawnSync(process.execPath, [bundle, '--version'], { cwd: work, encoding: 'utf8' });
    expect(version.status).toBe(0);
    expect(version.stdout.trim()).toBe(manifest.version);
    const help = spawnSync(process.execPath, [bundle, '--help'], { cwd: work, encoding: 'utf8' });
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('obsync-cli');
  });

  it('imports only Node built-ins', async () => {
    const code = await readFile(bundle, 'utf8');
    const imported = [...code.matchAll(/(?:from\s+|import\(|require\()\s*["']([^"']+)["']/g)].map((m) => m[1]!);
    expect(imported.filter((m) => !m.startsWith('node:') && !['fs', 'path', 'os', 'crypto', 'url', 'util', 'events', 'stream', 'buffer', 'module'].includes(m))).toEqual([]);
  });
});
