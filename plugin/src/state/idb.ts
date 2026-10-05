// A minimal promise layer over IndexedDB. Only IDB requests may be awaited
// inside a transaction; awaiting anything else lets it auto-commit.

export function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error('IndexedDB request failed'));
  });
}

export function done(t: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onabort = () => reject(t.error ?? new Error('IndexedDB transaction aborted'));
    t.onerror = () => reject(t.error ?? new Error('IndexedDB transaction failed'));
  });
}

export function openDb(factory: IDBFactory, name: string, version: number, upgrade: (db: IDBDatabase, oldVersion: number) => void): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = factory.open(name, version);
    r.onupgradeneeded = (ev) => upgrade(r.result, ev.oldVersion);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error(`cannot open IndexedDB ${name}`));
    r.onblocked = () => reject(new Error(`IndexedDB ${name} is open elsewhere with an older version`));
  });
}

/**
 * Runs body in one transaction and resolves with its result once the
 * transaction has committed (so a caller never acts on data that might
 * still roll back).
 */
export async function inTx<T>(db: IDBDatabase, stores: string[], mode: IDBTransactionMode, body: (t: IDBTransaction) => Promise<T>): Promise<T> {
  const t = db.transaction(stores, mode);
  const finished = done(t);
  let result: T;
  try {
    result = await body(t);
  } catch (err) {
    try {
      t.abort();
    } catch {
      // already finished
    }
    await finished.catch(() => undefined);
    throw err;
  }
  await finished;
  return result;
}
