// The keys of the failures store: one scheme for push (by path) and apply
// (by file id), shared by the state and the engine. No dependencies, so the
// state layer can use it without importing sync/.

export const FAILURE_PREFIX = { push: 'push:', apply: 'apply:' } as const;

export type FailureKind = keyof typeof FAILURE_PREFIX;

/** A local file that failed to push, by its path. */
export const pushKey = (path: string): string => `${FAILURE_PREFIX.push}${path}`;

/** A remote version that failed to apply, by its file id (hex). */
export const applyKey = (fileId: string): string => `${FAILURE_PREFIX.apply}${fileId}`;

/** The path of a push failure's key, or null for another kind of key. */
export function pathOfPushKey(key: string): string | null {
  return key.startsWith(FAILURE_PREFIX.push) ? key.slice(FAILURE_PREFIX.push.length) : null;
}
