// A line diff for the history view (what changed between two versions of a note).
import { diffComm } from 'node-diff3';

export type DiffLine = { kind: 'same' | 'add' | 'del'; text: string };

/** A diff of more lines than this is not computed: it could freeze a phone for seconds. */
export const MAX_DIFF_LINES = 5000;

/** Nor is one whose changed middle has more pairs of equal lines than this: diffComm's work grows with them (blank lines in a long note). */
export const MAX_DIFF_PAIRS = 500_000;

/** Pairs of equal lines, one from each side. */
function equalPairs(a: string[], b: string[]): number {
  const counts = new Map<string, number>();
  for (const l of a) counts.set(l, (counts.get(l) ?? 0) + 1);
  let n = 0;
  for (const l of b) n += counts.get(l) ?? 0;
  return n;
}

function lines(s: string): string[] {
  if (s === '') return [];
  return s.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
}

/** The lines of `after` against `before`, or null when the diff would be too costly (MAX_DIFF_LINES, MAX_DIFF_PAIRS). */
export function diffLines(before: string, after: string): DiffLine[] | null {
  const a = lines(before);
  const b = lines(after);
  if (a.length > MAX_DIFF_LINES || b.length > MAX_DIFF_LINES) return null;
  // The unchanged lines at both ends need no diffing; most edits leave only a small middle.
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);
  if (equalPairs(midA, midB) > MAX_DIFF_PAIRS) return null;
  const out: DiffLine[] = a.slice(0, head).map((text) => ({ kind: 'same', text }));
  for (const part of diffComm(midA, midB)) {
    if (part.common) for (const text of part.common) out.push({ kind: 'same', text });
    else {
      for (const text of part.buffer1) out.push({ kind: 'del', text });
      for (const text of part.buffer2) out.push({ kind: 'add', text });
    }
  }
  for (const text of a.slice(a.length - tail)) out.push({ kind: 'same', text });
  return out;
}
