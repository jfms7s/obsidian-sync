// Vault paths: vault-relative, '/'-separated, NFC (spec §5.1).

export class InvalidPathError extends Error {
  /** Why the name is refused, without the path (e.g. '"a:b" contains ":"'). */
  readonly why: string;

  constructor(path: string, why: string) {
    super(`invalid path ${JSON.stringify(path)}: ${why}`);
    this.name = 'InvalidPathError';
    this.why = why;
  }
}

function hasControlCharacter(s: string): boolean {
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) < 0x20) return true;
  return false;
}

const DEVICE_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const SHORT_NAME = /^[^.~]{1,6}~\d+/;

/**
 * Why Windows could open another name for seg, or null. NTFS resolves an
 * 8.3 short name (OBSIDI~1), an alternate stream (name::$INDEX_ALLOCATION)
 * and a name with trailing dots or spaces to the plain name, and a device
 * name (CON, nul.txt) to a device; a rule written for `.obsidian/` or
 * `.git/` would not see `OBSIDI~1/`. The same rule holds on every platform,
 * so no device commits a name another one would resolve differently
 * (cf. Git's CVE-2019-1352 and CVE-2019-1353).
 */
function windowsAlias(seg: string): string | null {
  if (seg.includes(':')) return 'contains ":"';
  if (seg.endsWith('.') || seg.endsWith(' ')) return 'ends in a dot or space';
  if (SHORT_NAME.test(seg)) return 'has the form of a Windows short name';
  if (DEVICE_NAME.test(seg.split('.')[0]!)) return 'is a Windows device name';
  return null;
}

/** Normalizes a vault path to the form file_id is computed from, or throws. */
export function normalizePath(path: string): string {
  const p = path.replace(/\\/g, '/').normalize('NFC');
  if (p === '') throw new InvalidPathError(path, 'empty');
  if (p.startsWith('/')) throw new InvalidPathError(path, 'must be vault-relative');
  if (p.endsWith('/')) throw new InvalidPathError(path, 'names a folder');
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.' || seg === '..') throw new InvalidPathError(path, `bad segment ${JSON.stringify(seg)}`);
    const alias = windowsAlias(seg);
    if (alias) throw new InvalidPathError(path, `${JSON.stringify(seg)} ${alias}`);
  }
  if (hasControlCharacter(p)) throw new InvalidPathError(path, 'contains a control character');
  // UTF-8 encoding would turn a lone surrogate into U+FFFD, so two different
  // names could share a file_id. (String.prototype.isWellFormed is ES2024,
  // newer than this package's lib target.)
  if (/\p{Cs}/u.test(p)) throw new InvalidPathError(path, 'contains an unpaired surrogate');
  return p;
}

/** Splits "dir/name.ext" into ["dir/", "name", ".ext"]; dotfiles have no extension. */
export function splitPath(path: string): { dir: string; stem: string; ext: string } {
  const slash = path.lastIndexOf('/');
  const dir = path.slice(0, slash + 1);
  const name = path.slice(slash + 1);
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return { dir, stem: name, ext: '' };
  return { dir, stem: name.slice(0, dot), ext: name.slice(dot) };
}

export function extension(path: string): string {
  return splitPath(path).ext.slice(1).toLowerCase();
}

/** The key two paths collide under on a case-insensitive file system. */
export function caseFold(path: string): string {
  return path.normalize('NFC').toLowerCase();
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** "YYYY-MM-DD HHmm" in local time, or in UTC with utc = true (a name every device must derive alike). */
export function conflictStamp(ms: number, utc = false): string {
  const d = new Date(ms);
  if (utc) return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}`;
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}${pad2(d.getMinutes())}`;
}

/** The device name a conflict copy carries when there is none. */
export const UNKNOWN_DEVICE = 'unknown device';

/**
 * A device name made safe for a file name: characters some platform forbids
 * become '-', at most 60 code points (never half a surrogate pair), and no
 * trailing dots or spaces (Windows drops them).
 */
export function sanitizeName(s: string): string {
  const cleaned = Array.from(s, (ch) => (ch.charCodeAt(0) < 0x20 || '\\/:*?"<>|'.includes(ch) ? '-' : ch)).join('').trim();
  const cut = Array.from(cleaned).slice(0, 60).join('').replace(/[ .]+$/, '');
  return cut === '' ? UNKNOWN_DEVICE : cut;
}

/**
 * The n-th candidate (n ≥ 1) for a conflict copy of path:
 * `name (conflict <device> <YYYY-MM-DD HHmm>).ext`, with " 2", " 3", …
 * added inside the parentheses for n > 1. The time is local unless utc.
 */
export function conflictCopyName(path: string, device: string, ms: number, n = 1, utc = false): string {
  const { dir, stem, ext } = splitPath(path);
  return `${dir}${stem} (conflict ${sanitizeName(device)} ${conflictStamp(ms, utc)}${n === 1 ? '' : ` ${n}`})${ext}`;
}

export const CONFLICT_COPY_PATTERN = / \(conflict .+ \d{4}-\d{2}-\d{2} \d{4}( \d+)?\)(\.[^./]*)?$/;
