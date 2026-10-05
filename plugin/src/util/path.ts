// Vault paths: vault-relative, '/'-separated, NFC (spec §5.1).

export class InvalidPathError extends Error {
  constructor(path: string, why: string) {
    super(`invalid path ${JSON.stringify(path)}: ${why}`);
    this.name = 'InvalidPathError';
  }
}

/** Normalizes a vault path to the form file_id is computed from, or throws. */
export function normalizePath(path: string): string {
  const p = path.replace(/\\/g, '/').normalize('NFC');
  if (p === '') throw new InvalidPathError(path, 'empty');
  if (p.startsWith('/')) throw new InvalidPathError(path, 'must be vault-relative');
  if (p.endsWith('/')) throw new InvalidPathError(path, 'names a folder');
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.' || seg === '..') throw new InvalidPathError(path, `bad segment ${JSON.stringify(seg)}`);
  }
  if (/[\u0000-\u001f]/.test(p)) throw new InvalidPathError(path, 'contains a control character');
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

/** "YYYY-MM-DD HHmm" in local time. */
export function conflictStamp(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}${pad2(d.getMinutes())}`;
}

/** Characters that are not allowed in file names on some platform. */
export function sanitizeName(s: string): string {
  const cleaned = s.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').trim();
  return cleaned === '' ? 'unknown device' : cleaned.slice(0, 60);
}

/**
 * The n-th candidate (n ≥ 1) for a conflict copy of path:
 * `name (conflict <device> <YYYY-MM-DD HHmm>).ext`, with " 2", " 3", …
 * added inside the parentheses for n > 1.
 */
export function conflictCopyName(path: string, device: string, ms: number, n = 1): string {
  const { dir, stem, ext } = splitPath(path);
  return `${dir}${stem} (conflict ${sanitizeName(device)} ${conflictStamp(ms)}${n === 1 ? '' : ` ${n}`})${ext}`;
}

export const CONFLICT_COPY_PATTERN = / \(conflict .+ \d{4}-\d{2}-\d{2} \d{4}( \d+)?\)(\.[^./]*)?$/;
