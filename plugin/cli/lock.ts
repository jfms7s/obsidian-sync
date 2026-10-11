// One obsync-cli at a time per state directory: the daemon and every
// command that changes the state hold <state-dir>/lock, which names their
// process. A lock whose process is gone (a crash, a kill -9) is taken over.
import { open, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';

export const LOCK_FILE = 'lock';

export class StateLockedError extends Error {
  constructor(readonly pid: number) {
    super(`another obsync-cli (pid ${pid}) is using this state directory; stop it first (systemctl --user stop obsync-cli)`);
    this.name = 'StateLockedError';
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'; // exists, owned by someone else
  }
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
  return Number.isInteger(pid) && pid > 0 && pid !== process.pid && alive(pid) ? pid : null;
}

/** Takes the lock (StateLockedError if a live process holds it); resolves with its release. */
export async function acquireLock(dir: string): Promise<() => Promise<void>> {
  const file = join(dir, LOCK_FILE);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fh = await open(file, 'wx', 0o600);
      try {
        await fh.writeFile(`${process.pid}\n`);
      } finally {
        await fh.close();
      }
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        if ((await readFile(file, 'utf8').catch(() => '')).trim() === String(process.pid)) await unlink(file).catch(() => undefined);
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const holder = await lockHolder(dir);
      if (holder !== null) throw new StateLockedError(holder);
      await unlink(file).catch(() => undefined); // stale: its process is gone
    }
  }
  throw new Error(`cannot take ${file}`);
}
