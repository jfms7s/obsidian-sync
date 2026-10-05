// Starts a real obsync server on a free port with a throwaway data
// directory, rate limits disabled (unless a test sets them), and creates
// users through the admin CLI.
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface TestServer {
  url: string;
  dataDir: string;
  createUser(username: string, password: string): Promise<void>;
  /** Stops the server, copies its data directory (a backup) and starts it again. */
  snapshot(): Promise<string>;
  /** Stops the server, replaces its data with a snapshot (a restore from backup) and starts it again on the same port. */
  restore(snapshot: string): Promise<void>;
  stop(): Promise<void>;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      s.close(() => (typeof addr === 'object' && addr ? resolve(addr.port) : reject(new Error('no port'))));
    });
  });
}

function serverEnv(dataDir: string, listen: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    OBSYNC_DATA_DIR: dataDir,
    OBSYNC_LISTEN: listen,
    OBSYNC_LOG_LEVEL: process.env['OBSYNC_TEST_LOG_LEVEL'] ?? 'error',
    // The suites run many devices from one address and far more requests
    // per second than a person; the limiters have their own tests.
    OBSYNC_RATE_LIMIT_DEVICE_RPS: '0',
    OBSYNC_RATE_LIMIT_IP_RPS: '0',
  };
}

async function waitReady(url: string, proc: ChildProcess): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) throw new Error(`obsync exited with ${proc.exitCode}`);
    try {
      const r = await fetch(`${url}/readyz`);
      if (r.ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('obsync did not become ready');
}

async function kill(proc: ChildProcess): Promise<void> {
  if (proc.exitCode !== null) return;
  const exited = new Promise((r) => proc.once('exit', r));
  proc.kill('SIGTERM');
  await exited;
}

export async function startServer(bin: string, opts: { env?: Record<string, string> } = {}): Promise<TestServer> {
  const dataDir = mkdtempSync(join(tmpdir(), 'obsync-data-'));
  const snapshots: string[] = [];
  let proc: ChildProcess;
  let env: NodeJS.ProcessEnv = {};
  let url = '';

  const launch = async (listen: string) => {
    env = { ...serverEnv(dataDir, listen), ...opts.env };
    proc = spawn(bin, ['serve'], { env, stdio: ['ignore', 'inherit', 'inherit'] });
    url = `http://${listen}`;
    try {
      await waitReady(url, proc);
    } catch (err) {
      proc.kill('SIGKILL');
      throw err;
    }
  };

  for (let attempt = 0; ; attempt++) {
    try {
      await launch(`127.0.0.1:${await freePort()}`);
      break;
    } catch (err) {
      if (attempt < 3) continue; // most likely the port was taken in between
      rmSync(dataDir, { recursive: true, force: true });
      throw err;
    }
  }
  const listen = url.slice('http://'.length);

  return {
    url,
    dataDir,
    createUser: (username, password) =>
      new Promise((resolve, reject) => {
        const child = execFile(bin, ['admin', 'user', 'create', '--username', username], { env }, (err, _out, stderr) =>
          err ? reject(new Error(`admin user create: ${stderr || err.message}`)) : resolve(),
        );
        child.stdin?.end(`${password}\n`);
      }),
    snapshot: async () => {
      await kill(proc);
      const copy = mkdtempSync(join(tmpdir(), 'obsync-snap-'));
      cpSync(dataDir, copy, { recursive: true });
      snapshots.push(copy);
      await launch(listen);
      return copy;
    },
    restore: async (snapshot) => {
      await kill(proc);
      rmSync(dataDir, { recursive: true, force: true });
      cpSync(snapshot, dataDir, { recursive: true });
      await launch(listen);
    },
    stop: async () => {
      await kill(proc);
      for (const d of [dataDir, ...snapshots]) rmSync(d, { recursive: true, force: true });
    },
  };
}
