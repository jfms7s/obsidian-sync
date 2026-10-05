// Which paths are not synced (spec §9.1): a fixed default list plus the
// user's own globs, stored per device.

/**
 * Never synced. The vault's configuration folder (Vault.configDir, usually
 * `.obsidian`) is ignored too, under the name the vault gives it: it
 * arrives as a personal layer in sub-project 4. Pass it as IgnoreOptions.configDir.
 */
export const DEFAULT_IGNORES: readonly string[] = [
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

/** A glob uses syntax these rules do not support. */
export class InvalidIgnorePatternError extends Error {
  constructor(readonly pattern: string, why: string) {
    super(`ignore pattern ${JSON.stringify(pattern)}: ${why}`);
    this.name = 'InvalidIgnorePatternError';
  }
}

/** null if pattern can be used, else why not (for a settings UI). */
export function validateIgnorePattern(pattern: string): string | null {
  const p = pattern.trim();
  if (p.startsWith('!')) return 'negation ("!") is not supported';
  if (p.includes('[')) return 'character classes ("[...]") are not supported';
  return null;
}

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
export function compileGlob(pattern: string, caseInsensitive = false): RegExp {
  const invalid = validateIgnorePattern(pattern);
  if (invalid !== null) throw new InvalidIgnorePatternError(pattern, invalid);
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
  return new RegExp(prefix + body + suffix, caseInsensitive ? 'i' : '');
}

export interface IgnoreOptions {
  /** Match regardless of letter case: set it from VaultAdapter.caseInsensitive. */
  caseInsensitive?: boolean;
  defaults?: readonly string[];
  /** The vault's configuration folder (Vault.configDir), ignored in addition to the defaults. */
  configDir?: string;
}

export class IgnoreRules {
  private readonly res: RegExp[];

  /** Throws InvalidIgnorePatternError for a glob that uses unsupported syntax ('!', '['). */
  constructor(readonly userGlobs: readonly string[] = [], opts: IgnoreOptions | readonly string[] = {}) {
    const o: IgnoreOptions = Array.isArray(opts) ? { defaults: opts as readonly string[] } : (opts as IgnoreOptions);
    const ci = o.caseInsensitive ?? false;
    const config = o.configDir?.replace(/^\/+|\/+$/g, '');
    this.res = [...(o.defaults ?? DEFAULT_IGNORES), ...(config ? [`${config}/`] : []), ...userGlobs]
      .filter((g) => g.trim() !== '' && !g.trim().startsWith('#'))
      .map((g) => compileGlob(g, ci));
  }

  matches(path: string): boolean {
    return this.res.some((re) => re.test(path));
  }
}
