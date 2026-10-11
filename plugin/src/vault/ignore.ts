import type { ConfigCarveOut } from './config-policy';

// Which paths are not synced (spec §9.1): a fixed default list, the vault's
// own .obsyncignore (synced, so every device shares it) and the user's own
// globs, stored per device. A path is ignored when any of them matches.

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

/**
 * The vault-level ignore file, at the vault root. It syncs like any file so
 * every device gets the same baseline, and no rule ever matches it: a `*`
 * line would otherwise stop the file itself from syncing and strand every
 * device on the rules it has.
 */
export const VAULT_IGNORE_FILE = '.obsyncignore';

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

/** Throws InvalidIgnorePatternError for the first pattern that uses unsupported syntax ('!', '['). */
export function assertValidIgnorePatterns(patterns: readonly string[]): void {
  for (const p of patterns) {
    const why = validateIgnorePattern(p);
    if (why !== null) throw new InvalidIgnorePatternError(p, why);
  }
}

export interface ParsedIgnoreFile {
  globs: string[];
  /** Lines skipped for unsupported syntax, with their 1-based line number (blank and comment lines count). */
  rejected: Array<{ line: number; pattern: string; why: string }>;
}

/**
 * One glob per line; blank lines and lines starting with '#' are skipped,
 * and so is a line that uses unsupported syntax: it is listed in rejected
 * and the rest of the text still applies.
 */
export function parseIgnoreFile(text: string): ParsedIgnoreFile {
  const globs: string[] = [];
  const rejected: ParsedIgnoreFile['rejected'] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const t = raw.trim();
    if (t === '' || t.startsWith('#')) return;
    const why = validateIgnorePattern(t);
    if (why === null) globs.push(t);
    else rejected.push({ line: i + 1, pattern: t, why });
  });
  return { globs, rejected };
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
  /** The globs of the vault's .obsyncignore (parseIgnoreFile), ignored in addition to the defaults. */
  vaultGlobs?: readonly string[];
  /**
   * The files in configDir that sync anyway (config-policy.ts): the config
   * folder's rule does not cover them, the other rules still do.
   */
  configSync?: ConfigCarveOut;
}

export class IgnoreRules {
  private readonly res: RegExp[];
  private readonly configRe: RegExp | null;
  private readonly configSync: ConfigCarveOut | null;
  private readonly ci: boolean;

  /** Throws InvalidIgnorePatternError for a glob that uses unsupported syntax ('!', '['). */
  constructor(readonly userGlobs: readonly string[] = [], o: IgnoreOptions = {}) {
    const ci = (this.ci = o.caseInsensitive ?? false);
    const config = o.configDir?.replace(/^\/+|\/+$/g, '');
    this.configRe = config ? compileGlob(`${config}/`, ci) : null;
    this.configSync = o.configSync ?? null;
    this.res = [...(o.defaults ?? DEFAULT_IGNORES), ...(o.vaultGlobs ?? []), ...userGlobs]
      .filter((g) => g.trim() !== '' && !g.trim().startsWith('#'))
      .map((g) => compileGlob(g, ci));
  }

  matches(path: string): boolean {
    if (isVaultIgnoreFile(path, this.ci)) return false;
    if (this.configRe?.test(path) && !this.configSync?.syncs(path)) return true;
    return this.res.some((re) => re.test(path));
  }

  /**
   * Whether a walk of the vault can skip the folder and everything in it.
   * The config folder (and its plugins/ and plugins/<id>/ folders) is
   * entered only while the settings policy may sync a file in it.
   */
  skipsFolder(folder: string): boolean {
    const asFolder = `${folder}/`;
    if (this.configRe?.test(asFolder) && !this.configSync?.mayHoldSynced(folder)) return true;
    return this.res.some((re) => re.test(asFolder));
  }
}

/** path is the vault's .obsyncignore (the one at the root; a nested one is an ordinary file). */
export function isVaultIgnoreFile(path: string, caseInsensitive = false): boolean {
  return caseInsensitive ? path.toLowerCase() === VAULT_IGNORE_FILE : path === VAULT_IGNORE_FILE;
}
