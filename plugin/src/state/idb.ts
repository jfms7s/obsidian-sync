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

/**
 * Opens (and upgrades) a database. The connection closes itself when another
 * one needs a newer version, so this device never blocks an upgrade in
 * another tab or window; callers notice by their next transaction failing.
 * A blocked open rejects at once, and if it goes through later anyway, that
 * late connection is closed instead of leaking.
 */
export function openDb(factory: IDBFactory, name: string, version: number, upgrade: (db: IDBDatabase, oldVersion: number, tx: IDBTransaction) => void): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const r = factory.open(name, version);
    r.onupgradeneeded = (ev) => upgrade(r.result, ev.oldVersion, r.transaction!);
    r.onsuccess = () => {
      const db = r.result;
      if (settled) {
        db.close();
        return;
      }
      settled = true;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    r.onerror = () => {
      settled = true;
      reject(r.error ?? new Error(`cannot open IndexedDB ${name}`));
    };
    r.onblocked = () => {
      if (settled) return;
      settled = true;
      reject(new Error(`IndexedDB ${name} is open elsewhere with an older version`));
    };
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
