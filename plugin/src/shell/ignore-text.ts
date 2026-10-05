// The ignore rules as the user edits them: one glob per line.
import { validateIgnorePattern } from '../vault/ignore';

export interface IgnoreTextResult {
  globs: string[];
  /** Problems, with the 1-based line of the text itself (blank and comment lines count). */
  errors: Array<{ line: number; text: string; message: string }>;
}

export function parseIgnoreText(text: string): IgnoreTextResult {
  const globs: string[] = [];
  const errors: IgnoreTextResult['errors'] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const t = raw.trim();
    if (t === '' || t.startsWith('#')) return;
    const why = validateIgnorePattern(t);
    if (why === null) globs.push(t);
    else errors.push({ line: i + 1, text: t, message: why });
  });
  return { globs, errors };
}

export function formatIgnoreText(globs: readonly string[]): string {
  return globs.join('\n');
}
