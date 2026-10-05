import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Loads plugin/test/vectors/<name>, written by server/cmd/vectorgen. */
export function loadVectors<T>(name: string): T {
  const path = fileURLToPath(new URL(`../vectors/${name}`, import.meta.url));
  return (JSON.parse(readFileSync(path, 'utf8')) as { vectors: T }).vectors;
}
