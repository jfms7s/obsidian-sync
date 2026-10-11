// obsync-cli end to end (spec test plan, "Server test"): the bundled CLI,
// run by Node as a user would, logs in, unlocks, chooses the vault and
// syncs a real folder with the test server, next to an engine device.
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { cliOptions } from '../../esbuild.config.mjs';
import { makeClient, type SimClient } from '../helpers/client';
import { files, newUser, PASSPHRASE, text, type User } from '../helpers/fixture';
import { startServer, type TestServer } from '../helpers/server';

let srv: TestServer;
let work: string;
let bundle: string;
beforeAll(async () => {
  srv = await startServer(inject('obsyncBin'));
  work = await mkdtemp(join(tmpdir(), 'obsync-cli-e2e-'));
  bundle = join(work, 'obsync-cli.mjs');
  await build({ ...cliOptions(), outfile: bundle, logLevel: 'silent' });
});
afterAll(async () => {
  await srv?.stop();
  if (work) await rm(work, { recursive: true, force: true });
});

interface Result {
  code: number | null;
  out: string;
  err: string;
}

/** Starts the CLI; secret (if given) is written to its file descriptor 3. */
function start(args: string[], secret?: string): { child: ChildProcess; done: Promise<Result> } {
  const env = { ...process.env, XDG_STATE_HOME: join(work, 'xdg'), OBSYNC_CLI_HEARTBEAT_CHECK_MS: '200' };
  const child = spawn(process.execPath, [bundle, ...args], { stdio: ['ignore', 'pipe', 'pipe', 'pipe'], env });
  let out = '';
  let err = '';
  child.stdout!.on('data', (d: Buffer) => (out += d.toString()));
  child.stderr!.on('data', (d: Buffer) => (err += d.toString()));
  const fd3 = child.stdio[3] as NodeJS.WritableStream;
  if (secret !== undefined) fd3.end(`${secret}\n`);
  else fd3.end();
  const done = new Promise<Result>((resolve) => child.on('close', (code) => resolve({ code, out, err })));
  return { child, done };
}

const cli = (args: string[], secret?: string) => start(args, secret).done;

async function until(what: string, check: () => Promise<boolean>, ms = 20_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

const readText = (p: string) => readFile(p, 'utf8').catch(() => null);

describe('obsync-cli against the real server', () => {
  let user: User;
  let phone: SimClient;
  let stateDir: string;
  let vaultDir: string;
  const S = () => ['--state-dir', stateDir];

  beforeAll(async () => {
    user = await newUser(srv);
    phone = await makeClient(srv, user, { name: 'Phone', vault: 'create' });
    stateDir = join(work, 'state');
    vaultDir = join(work, 'vault');
    await mkdir(vaultDir);
    await mkdir(join(vaultDir, '.obsidian'));
    await writeFile(join(vaultDir, '.obsidian', 'app.json'), '{}');
  });

  it('needs a login before anything else, and says so with exit code 2', async () => {
    const r = await cli(['sync', '--vault-dir', vaultDir, ...S()]);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/not logged in/);
  });

  it('logs in, unlocks with the passphrase and chooses the vault', async () => {
    const wrong = await cli(['login', '--server', srv.url, '--username', user.username, '--password-fd', '3', ...S()], 'not the password');
    expect(wrong.code).toBe(1);
    expect(wrong.err).toMatch(/wrong username or password/);
    const login = await cli(['login', '--server', srv.url, '--username', user.username, '--device-name', 'Desktop CLI', '--password-fd', '3', ...S()], user.password);
    expect(login.code, login.err).toBe(0);
    expect(login.out).toMatch(/obsync-cli unlock/);
    expect((await stat(stateDir)).mode & 0o777).toBe(0o700);

    expect((await cli(['vaults', ...S()])).code).toBe(2); // locked
    const badPass = await cli(['unlock', '--passphrase-fd', '3', ...S()], 'wrong passphrase');
    expect(badPass.code).toBe(1);
    const unlock = await cli(['unlock', '--passphrase-fd', '3', ...S()], PASSPHRASE);
    expect(unlock.code, unlock.err).toBe(0);

    const list = await cli(['vaults', ...S()]);
    expect(list.code).toBe(0);
    expect(list.out).toContain(phone.vaultId);
    expect(list.out).toContain(`vault of ${user.username}`);
    const choose = await cli(['vaults', '--choose', phone.vaultId, ...S()]);
    expect(choose.code, choose.err).toBe(0);
  });

  it('refuses to sync a folder for the first time without --init', async () => {
    const r = await cli(['sync', '--vault-dir', vaultDir, '--once', ...S()]);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/--init/);
  });

  it('syncs both ways as a daemon: a file written in the folder reaches the device, an edit on the device reaches the folder', async () => {
    await writeFile(join(vaultDir, 'before.md'), 'written before the first sync\n');
    const daemon = start(['sync', '--vault-dir', vaultDir, '--init', '--verbose', ...S()]);
    try {
      await until('the first upload', async () => {
        await phone.engine.runCycle();
        return files(phone.adapter)['before.md'] === 'written before the first sync\n';
      });
      // Another program (an editor, an agent) writes into the folder while the daemon runs.
      await mkdir(join(vaultDir, 'Notes'));
      await writeFile(join(vaultDir, 'Notes', 'from-cli.md'), '# written in the folder\n');
      await until('the file to reach the device', async () => {
        await phone.engine.runCycle();
        return files(phone.adapter)['Notes/from-cli.md'] === '# written in the folder\n';
      });
      await phone.adapter.write('from-phone.md', text('typed on the phone\n'));
      await phone.adapter.write('Notes/from-cli.md', text('# written in the folder\nedited on the phone\n'));
      await phone.engine.runCycle();
      await until('the edits to reach the folder', async () =>
        (await readText(join(vaultDir, 'from-phone.md'))) === 'typed on the phone\n'
        && (await readText(join(vaultDir, 'Notes', 'from-cli.md'))) === '# written in the folder\nedited on the phone\n');
      // The config folder is the device's own: never uploaded.
      expect(Object.keys(files(phone.adapter)).some((p) => p.startsWith('.obsidian/'))).toBe(false);

      const st = await cli(['status', ...S()]);
      expect(st.out).toMatch(/daemon: +running/);
      // State-changing commands wait for the daemon to stop.
      const busy = await cli(['vaults', '--choose', phone.vaultId, ...S()]);
      expect(busy.code).toBe(1);
      expect(busy.err).toMatch(/another obsync-cli/);
    } finally {
      daemon.child.kill('SIGTERM');
    }
    const r = await daemon.done;
    expect(r.code, r.err).toBe(0);
    expect(r.err).toMatch(/sync stopped/);
    expect(r.err).toMatch(/state saved in/);
    const status = await cli(['status', ...S()]);
    expect(status.code).toBe(0);
    expect(status.out).toMatch(/daemon: +not running/);
    expect(status.out).toContain(vaultDir);
  });

  it('syncs one round with --once, and refuses another folder', async () => {
    await writeFile(join(vaultDir, 'once.md'), 'one round\n');
    const r = await cli(['sync', '--vault-dir', vaultDir, '--once', ...S()]);
    expect(r.code, r.err).toBe(0);
    await phone.engine.runCycle();
    expect(files(phone.adapter)['once.md']).toBe('one round\n');
    const other = await mkdtemp(join(work, 'other-'));
    const refused = await cli(['sync', '--vault-dir', other, '--once', '--init', ...S()]);
    expect(refused.code).toBe(2);
    expect(refused.err).toMatch(/this state syncs/);
  });

  it('holds off while Obsidian\'s plugin syncs the folder (fresh heartbeat), and resumes with a full check once it stops', async () => {
    // The plugin installed under another folder name (a dev copy): its heartbeat counts all the same.
    const beat = join(vaultDir, '.obsidian', 'plugins', 'obsync-dev', 'active');
    await mkdir(join(vaultDir, '.obsidian', 'plugins', 'obsync-dev'), { recursive: true });
    await mkdir(join(vaultDir, '.obsidian', 'plugins', 'other-plugin'), { recursive: true });
    await writeFile(join(vaultDir, '.obsidian', 'plugins', 'other-plugin', 'active'), 'not a heartbeat');
    const fresh = () => writeFile(beat, JSON.stringify({ obsync: 1, at: Date.now(), device: 'Laptop' }));
    await fresh();
    await writeFile(join(vaultDir, 'while-obsidian-runs.md'), 'Obsidian would sync this one\n');
    const once = await cli(['sync', '--vault-dir', vaultDir, '--once', ...S()]);
    expect(once.code, once.err).toBe(0);
    expect(once.err).toMatch(/Obsidian is syncing this folder \(device "Laptop"\): nothing to do/);

    const daemon = start(['sync', '--vault-dir', vaultDir, ...S()]);
    try {
      await until('the daemon to start paused', async () => (await cli(['status', ...S()])).out.includes('paused since'));
      await new Promise((r) => setTimeout(r, 1000));
      await phone.engine.runCycle();
      expect(files(phone.adapter)['while-obsidian-runs.md']).toBeUndefined(); // nothing was uploaded
      await rm(beat); // Obsidian closed: the plugin removed its heartbeat
      await until('the file to be uploaded after the resume', async () => {
        await phone.engine.runCycle();
        return files(phone.adapter)['while-obsidian-runs.md'] === 'Obsidian would sync this one\n';
      });
      // Obsidian opens again: the daemon pauses after its cycle.
      await fresh();
      await until('the daemon to pause again', async () => (await cli(['status', ...S()])).out.includes('paused since'));
      await writeFile(join(vaultDir, 'second.md'), 'not now\n');
      await new Promise((r) => setTimeout(r, 1000));
      await phone.engine.runCycle();
      expect(files(phone.adapter)['second.md']).toBeUndefined();
      // A heartbeat that stopped (Obsidian killed) is stale after 90 s: one from 2 minutes ago resumes at once.
      await writeFile(beat, JSON.stringify({ obsync: 1, at: Date.now() - 120_000, device: 'Laptop' }));
      await until('the resume after a stale heartbeat', async () => {
        await phone.engine.runCycle();
        return files(phone.adapter)['second.md'] === 'not now\n';
      });
    } finally {
      daemon.child.kill('SIGTERM');
    }
    const r = await daemon.done;
    expect(r.code, r.err).toBe(0);
    expect(r.err).toMatch(/pausing/);
    expect(r.err).toMatch(/resuming with a full check/);
  });

  it('ends with an error, for the service manager to restart it, when it cannot resume (the folder is gone)', async () => {
    const plugin = join(vaultDir, '.obsidian', 'plugins', 'obsync');
    await mkdir(plugin, { recursive: true });
    await writeFile(join(plugin, 'active'), JSON.stringify({ obsync: 1, at: Date.now(), device: 'Laptop' }));
    const daemon = start(['sync', '--vault-dir', vaultDir, ...S()]);
    const away = `${vaultDir}-gone`;
    try {
      await until('the daemon to start paused', async () => (await cli(['status', ...S()])).out.includes('paused since'));
      await rename(vaultDir, away); // the heartbeat goes with it: the daemon tries to resume
      const r = await daemon.done;
      expect(r.code).toBe(1);
      expect(r.err).toMatch(/cannot resume/);
    } finally {
      daemon.child.kill('SIGTERM');
      await daemon.done;
      await rename(away, vaultDir).catch(() => undefined);
      await rm(join(plugin, 'active'), { force: true });
    }
  });

  it('refuses a vault folder that is empty when files were synced from it (a disk not mounted)', async () => {
    const away = `${vaultDir}-away`;
    await rename(vaultDir, away);
    await mkdir(vaultDir);
    try {
      const r = await cli(['sync', '--vault-dir', vaultDir, '--once', ...S()]);
      expect(r.code).toBe(2);
      expect(r.err).toMatch(/is empty, but \d+ files were synced from it/);
      await phone.engine.runCycle();
      expect(files(phone.adapter)['once.md']).toBe('one round\n'); // nothing was deleted
    } finally {
      await rm(vaultDir, { recursive: true });
      await rename(away, vaultDir);
    }
  });

  it('logs out: the device is revoked and the state deleted', async () => {
    const cliDevice = () => phone.api.listDevices().then((ds) => ds.find((d) => d.name === 'Desktop CLI'));
    expect((await cliDevice())?.revoked).toBe(false);
    expect((await cliDevice())?.platform).toBe(`cli-${process.platform}`);
    const r = await cli(['logout', ...S()]);
    expect(r.code, r.err).toBe(0);
    expect((await cliDevice())?.revoked ?? true).toBe(true);
    expect((await cli(['status', ...S()])).code).toBe(2);
  });
});
