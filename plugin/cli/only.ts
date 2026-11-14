// `obsync-cli sync --only FOLDER/`: a copy of chosen folders only. The list
// is stored with the folder binding, and written to a marker file at the
// vault root so a person looking at the folder can tell it is partial.
import { chmod, open, rename, rm, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { normalizePath, ONLY_MARKER_FILE } from '../src/index';
import { CliError } from './exit';

/** The setting holding the --only list a state was set up with (null: every folder). */
export const ONLY_SETTING = 'cli.onlyFolders';

/**
 * Names obsync keeps for itself at the vault root (compared case-folded): the
 * engine's records of versions outside the list, and the marker file.
 */
const OWN_NAMES = ['.obsync-outside', ONLY_MARKER_FILE];
const PATTERN_CHARACTERS = /[*?[\]!#\\]/;

function folderProblem(f: string): string | null {
  if (!f.endsWith('/')) return 'name a folder with a trailing "/"';
  const path = f.slice(0, -1);
  const segments = path.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..')) return 'use a plain folder path from the vault root';
  if (PATTERN_CHARACTERS.test(path)) return 'no pattern characters (* ? [ ] ! # \\)';
  if (segments.some((s) => s.trim() !== s)) return 'no spaces at the start or end of a name';
  if (OWN_NAMES.includes(segments[0]!.toLowerCase())) return 'that name at the vault root is obsync\'s own';
  try {
    if (normalizePath(path) !== path) return 'not a normalized vault path';
  } catch {
    return 'not a valid vault path'; // normalizePath's message would name the folder
  }
  return null;
}

/**
 * The --only arguments, checked, once each and sorted; throws CliError (exit 1)
 * on the first bad one. Messages never name a folder (the list may be private):
 * a bad one is told by its position.
 */
export function parseOnlyFolders(args: readonly string[]): string[] {
  args.forEach((f, i) => {
    const why = folderProblem(f);
    if (why !== null) throw new CliError(`--only number ${i + 1}: ${why}`);
  });
  return [...new Set(args)].sort();
}

/** Whether two folder lists hold the same folders. */
export function sameFolders(a: readonly string[], b: readonly string[]): boolean {
  const x = [...new Set(a)].sort();
  const y = [...new Set(b)].sort();
  return x.length === y.length && x.every((f, i) => f === y[i]);
}

/** Writes the marker file at the vault root (one folder per line), or removes it without a list. */
export async function syncMarker(vaultDir: string, folders: readonly string[] | null): Promise<void> {
  const path = join(vaultDir, ONLY_MARKER_FILE);
  if (folders === null) {
    await rm(path, { force: true });
    return;
  }
  const tmp = `${path}.tmp`;
  try {
    const fh = await open(tmp, 'w', 0o644);
    try {
      await fh.writeFile(folders.join('\n') + '\n');
      await fh.sync();
    } finally {
      await fh.close();
    }
    await chmod(tmp, 0o644); // whatever the umask
    await rename(tmp, path);
  } catch (err) {
    await unlink(tmp).catch(() => undefined);
    throw err;
  }
}
