// Starts a real obsync server on a port it picks itself (127.0.0.1:0, read
// back from its "obsync listening" log line, so parallel test files can
// never race for a port), with a throwaway data directory and rate limits
// disabled (unless a test sets them), and creates users through the admin CLI.
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

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

const LEVELS = ['DEBUG', 'INFO', 'WARN', 'ERROR'];
/** Server log lines at or above this level are copied to the test's stderr. */
const SHOW_LEVEL = Math.max(0, LEVELS.indexOf((process.env['OBSYNC_TEST_LOG_LEVEL'] ?? 'error').toUpperCase()));

function serverEnv(dataDir: string, listen: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    OBSYNC_DATA_DIR: dataDir,
    OBSYNC_LISTEN: listen,
    // INFO at least: the harness reads the bound address from the log.
    OBSYNC_LOG_LEVEL: SHOW_LEVEL === 0 ? 'debug' : 'info',
    // The suites run many devices from one address and far more requests
    // per second than a person; the limiters have their own tests.
    OBSYNC_RATE_LIMIT_DEVICE_RPS: '0',
    OBSYNC_RATE_LIMIT_IP_RPS: '0',
  };
}

interface LogLine {
  level?: string;
  msg?: string;
  addr?: string;
}

function parseLogLine(line: string): LogLine | null {
  try {
    const v: unknown = JSON.parse(line);
    return typeof v === 'object' && v !== null ? (v as LogLine) : null;
  } catch {
    return null; // not a log record
  }
}

/** Resolves with the address from the child's "obsync listening" line; rejects if it exits first. */
function boundAddress(proc: ChildProcess, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const tail: string[] = [];
    let done = false;
    const finish = (f: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      f();
    };
    const timer = setTimeout(() => finish(() => reject(new Error('obsync did not report a listening address'))), timeoutMs);
    createInterface({ input: proc.stderr! }).on('line', (line) => {
      const rec = parseLogLine(line);
      if (rec === null || LEVELS.indexOf(rec.level ?? 'ERROR') >= SHOW_LEVEL) process.stderr.write(`${line}\n`);
      tail.push(line);
      if (tail.length > 20) tail.shift();
      const addr = rec?.msg === 'obsync listening' ? rec.addr : undefined;
      if (typeof addr === 'string') finish(() => resolve(addr));
    });
    proc.once('exit', (code, signal) =>
      finish(() => reject(new Error(`obsync exited (${code ?? signal}) before listening:\n${tail.join('\n')}`))));
  });
}

async function waitReady(url: string, proc: ChildProcess): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null || proc.signalCode !== null) throw new Error(`obsync exited with ${proc.exitCode ?? proc.signalCode}`);
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

/** SIGTERM, then SIGKILL if the process has not exited within 5 s; resolves once it has exited. */
async function kill(proc: ChildProcess): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  const exited = new Promise((r) => proc.once('exit', r));
  proc.kill('SIGTERM');
  const force = setTimeout(() => proc.kill('SIGKILL'), 5_000);
  await exited;
  clearTimeout(force);
}

export async function startServer(bin: string, opts: { env?: Record<string, string> } = {}): Promise<TestServer> {
  const dataDir = mkdtempSync(join(tmpdir(), 'obsync-data-'));
  const snapshots: string[] = [];
  let proc: ChildProcess;
  let env: NodeJS.ProcessEnv = {};
  let url = '';

  const launchOnce = async (listen: string): Promise<string> => {
    env = { ...serverEnv(dataDir, listen), ...opts.env };
    proc = spawn(bin, ['serve'], { env, stdio: ['ignore', 'inherit', 'pipe'] });
    try {
      const addr = await boundAddress(proc, 20_000);
      await waitReady(`http://${addr}`, proc);
      return addr;
    } catch (err) {
      await kill(proc);
      throw err;
    }
  };

  // A restart must reuse the port (clients hold the URL). Another process
  // may have taken it meanwhile; that shows up as an early exit, so retry.
  const relaunch = async (listen: string) => {
    for (let attempt = 0; ; attempt++) {
      try {
        await launchOnce(listen);
        return;
      } catch (err) {
        if (attempt >= 5) throw err;
        await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
      }
    }
  };

  try {
    url = `http://${await launchOnce('127.0.0.1:0')}`;
  } catch (err) {
    rmSync(dataDir, { recursive: true, force: true });
    throw err;
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
      await relaunch(listen);
      return copy;
    },
    restore: async (snapshot) => {
      await kill(proc);
      rmSync(dataDir, { recursive: true, force: true });
      cpSync(snapshot, dataDir, { recursive: true });
      await relaunch(listen);
    },
    stop: async () => {
      await kill(proc);
      for (const d of [dataDir, ...snapshots]) rmSync(d, { recursive: true, force: true });
    },
  };
}
