// Which paths are not synced (spec §9.1): a fixed default list plus the
// user's own globs, stored per device.

/** `.obsidian/` arrives as a personal layer in sub-project 4; the rest is never synced. */
export const DEFAULT_IGNORES: readonly string[] = [
  '.obsidian/',
  '.trash/',
  '.git/',
  '.DS_Store',
  '._*',
  '.Spotlight-V100/',
  '.fseventsd/',
  '.Trashes/',
  'Thumbs.db',
  'desktop.ini',
  '~$*',
  '*.tmp',
  '*.swp',
];

function escape(ch: string): string {
  return /[\\^$.*+?()[\]{}|]/.test(ch) ? `\\${ch}` : ch;
}

/** One glob segment ('*', '?' and literals) as a regex fragment that never crosses '/'. */
function segment(glob: string): string {
  let out = '';
  for (const ch of glob) out += ch === '*' ? '[^/]*' : ch === '?' ? '[^/]' : escape(ch);
  return out;
}

/**
 * Compiles a gitignore-like glob:
 * - `name` (no '/') matches a file or folder with that name at any depth;
 * - a pattern containing '/' is anchored at the vault root, and `**` matches any number of folders;
 * - a trailing '/' matches folders only (so everything inside them).
 */
export function compileGlob(pattern: string): RegExp {
  let p = pattern.trim().replace(/^\.\//, '');
  const dirOnly = p.endsWith('/');
  if (dirOnly) p = p.replace(/\/+$/, '');
  const anchored = p.includes('/');
  p = p.replace(/^\//, '');
  const parts = p.split('/').map((s) => (s === '**' ? '(?:.*/)?' : segment(s) + '/'));
  let body = parts.join('').replace(/\/$/, '');
  body = body.replace(/\(\?:\.\*\/\)\?\/?$/, '.*');
  const prefix = anchored ? '^' : '(?:^|/)';
  const suffix = dirOnly ? '/' : '(?:$|/)';
  return new RegExp(prefix + body + suffix);
}

export class IgnoreRules {
  private readonly res: RegExp[];

  constructor(readonly userGlobs: readonly string[] = [], defaults: readonly string[] = DEFAULT_IGNORES) {
    this.res = [...defaults, ...userGlobs].filter((g) => g.trim() !== '' && !g.trim().startsWith('#')).map(compileGlob);
  }

  matches(path: string): boolean {
    return this.res.some((re) => re.test(path));
  }
}
