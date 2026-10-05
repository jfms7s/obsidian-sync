// One sync engine per vault, even across a plugin reload. Obsidian does not
// wait for the old plugin instance's onunload to finish before it loads the
// new one, so the new instance's engine could start while the old one is
// still finishing a cycle: two engines writing the same state and files. The
// engine lock is held for an engine's whole life and given back after it has
// stopped, so the new instance simply waits its turn.

/** The part of navigator.locks the lock uses (a Web Locks API). */
export interface LockManagerLike {
  request<T>(name: string, callback: () => Promise<T> | T): Promise<T>;
}

export interface EngineLock {
  /** Resolves with the release function once no other holder of this name is left. */
  acquire(): Promise<() => void>;
}

export interface LockDeps {
  /** undefined: navigator.locks where it exists; null: use the in-memory queue. */
  locks?: LockManagerLike | null;
  /** The in-memory queue's state; by default one shared by every plugin instance in this window. */
  registry?: Map<string, Promise<void>>;
}

const moduleRegistry = new Map<string, Promise<void>>();

/** Survives a plugin reload, which evaluates this module again: it lives on the window, not in the module. */
function sharedRegistry(): Map<string, Promise<void>> {
  if (typeof window === 'undefined') return moduleRegistry; // not in Obsidian (tests, tools)
  const w = window as unknown as { __obsyncEngineLocks?: Map<string, Promise<void>> };
  return (w.__obsyncEngineLocks ??= new Map<string, Promise<void>>());
}

function once(fn: () => void): () => void {
  let done = false;
  return () => {
    if (done) return;
    done = true;
    fn();
  };
}

export function createEngineLock(name: string, deps: LockDeps = {}): EngineLock {
  const locks = deps.locks === undefined ? (typeof navigator !== 'undefined' && 'locks' in navigator ? (navigator.locks as unknown as LockManagerLike) : null) : deps.locks;
  if (locks) {
    return {
      acquire: () =>
        new Promise<() => void>((resolve) => {
          // The lock is held while this callback's promise is pending.
          void locks.request(name, () => new Promise<void>((held) => resolve(once(held))));
        }),
    };
  }
  const registry = deps.registry ?? sharedRegistry();
  return {
    acquire: async () => {
      const previous = registry.get(name) ?? Promise.resolve();
      let release!: () => void;
      const mine = new Promise<void>((r) => (release = r));
      registry.set(name, previous.then(() => mine));
      await previous;
      return once(release);
    },
  };
}
