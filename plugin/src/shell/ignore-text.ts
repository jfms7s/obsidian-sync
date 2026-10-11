// The ignore rules as the user edits them: one glob per line.
import { parseIgnoreFile } from '../vault/ignore';

export interface IgnoreTextResult {
  globs: string[];
  /** Problems, with the 1-based line of the text itself (blank and comment lines count). */
  errors: Array<{ line: number; text: string; message: string }>;
}

export function parseIgnoreText(text: string): IgnoreTextResult {
  const { globs, rejected } = parseIgnoreFile(text);
  return { globs, errors: rejected.map((r) => ({ line: r.line, text: r.pattern, message: r.why })) };
}

export function formatIgnoreText(globs: readonly string[]): string {
  return globs.join('\n');
}
