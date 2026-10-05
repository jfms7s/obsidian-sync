// A line diff for the history view (what changed between two versions of a note).
import { diffComm } from 'node-diff3';

export type DiffLine = { kind: 'same' | 'add' | 'del'; text: string };

/** A diff of more lines than this is not computed: it could freeze a phone for seconds. */
export const MAX_DIFF_LINES = 5000;

function lines(s: string): string[] {
  if (s === '') return [];
  return s.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
}

/** The lines of `after` against `before`, or null when either has more than MAX_DIFF_LINES lines. */
export function diffLines(before: string, after: string): DiffLine[] | null {
  const a = lines(before);
  const b = lines(after);
  if (a.length > MAX_DIFF_LINES || b.length > MAX_DIFF_LINES) return null;
  const out: DiffLine[] = [];
  for (const part of diffComm(a, b)) {
    if (part.common) for (const text of part.common) out.push({ kind: 'same', text });
    else {
      for (const text of part.buffer1) out.push({ kind: 'del', text });
      for (const text of part.buffer2) out.push({ kind: 'add', text });
    }
  }
  return out;
}
