// One obsync-cli at a time per state directory: the daemon and every
// command that changes the state hold <state-dir>/lock, which names their
// process. A lock whose process is gone (a crash, a kill -9) is taken over.
import { randomBytes } from 'node:crypto';
import { link, open, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';

export const LOCK_FILE = 'lock';

export class StateLockedError extends Error {
  constructor(readonly pid: number) {
    super(`another obsync-cli (pid ${pid}) is using this state directory; stop it first (systemctl --user stop obsync-cli)`);
    this.name = 'StateLockedError';
  }
}

/**
 * Whether pid is an obsync-cli still running. After a crash and a reboot
 * the pid may belong to some other program: where /proc tells, a process
 * that is not running obsync-cli does not hold the lock.
 */
async function alive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EPERM') return false; // EPERM: exists, owned by someone else
  }
  let cmdline: string;
  try {
    cmdline = await readFile(`/proc/${pid}/cmdline`, 'utf8');
  } catch {
    return true; // no /proc (macOS), or not ours to read: trust the pid
  }
  return /obsync/i.test(cmdline);
}

/** The pid holding the lock in dir, or null (no lock, or its process is gone). */
export async function lockHolder(dir: string): Promise<number | null> {
  let text: string;
  try {
    text = await readFile(join(dir, LOCK_FILE), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  const pid = Number.parseInt(text.trim(), 10);
  return Number.isInteger(pid) && pid > 0 && pid !== process.pid && (await alive(pid)) ? pid : null;
}

/** Takes the lock (StateLockedError if a live process holds it); resolves with its release. */
export async function acquireLock(dir: string): Promise<() => Promise<void>> {
  const file = join(dir, LOCK_FILE);
  for (let attempt = 0; attempt < 3; attempt++) {
    // The pid goes into a file of its own, which is then linked to the lock's name; that fails
    // if the lock exists. So nobody ever sees a lock file without its pid.
    const tmp = join(dir, `.lock-${process.pid}-${randomBytes(4).toString('hex')}`);
    const fh = await open(tmp, 'wx', 0o600);
    try {
      await fh.writeFile(`${process.pid}\n`);
    } finally {
      await fh.close();
    }
    try {
      try {
        await link(tmp, file);
      } finally {
        await unlink(tmp).catch(() => undefined);
      }
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        if ((await readFile(file, 'utf8').catch(() => '')).trim() === String(process.pid)) await unlink(file).catch(() => undefined);
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const before = await readFile(file, 'utf8').catch(() => null);
      const holder = await lockHolder(dir);
      if (holder !== null) throw new StateLockedError(holder);
      // Stale (its process is gone): removed only while it still names that process, so a
      // lock another process has just taken over is not removed from under it.
      if (before !== null && (await readFile(file, 'utf8').catch(() => null)) === before) await unlink(file).catch(() => undefined);
    }
  }
  throw new Error(`cannot take ${file}`);
}
