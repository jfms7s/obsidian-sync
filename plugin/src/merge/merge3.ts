// Three-way merge of text files (spec §5.5) on top of node-diff3, which
// follows GNU diff3: changes to the same or adjacent lines conflict.
import { diff3Merge } from 'node-diff3';

export type Eol = '\n' | '\r\n';

export interface MergeResult {
  /** false: overlapping changes; the caller keeps local and writes remote as a conflict copy. */
  clean: boolean;
  /** The merged text when clean, written with local's line endings. */
  text: string;
}

/** CRLF if most line breaks in s are CRLF, else LF (also for text without line breaks). */
export function detectEol(s: string): Eol {
  const crlf = (s.match(/\r\n/g) ?? []).length;
  const lf = (s.match(/\n/g) ?? []).length - crlf;
  return crlf > lf ? '\r\n' : '\n';
}

function lf(s: string): string {
  return s.replace(/\r\n/g, '\n');
}

function withEol(s: string, eol: Eol): string {
  return eol === '\n' ? s : s.replace(/\n/g, '\r\n');
}

/**
 * Merges local and remote edits of base. Line endings are normalized to LF
 * for comparison only: the result uses local's line endings. A trailing
 * newline is an ordinary (empty last) line, so adding or removing one is an
 * edit like any other.
 */
export function merge3(base: string, local: string, remote: string): MergeResult {
  if (local === remote || base === remote) return { clean: true, text: local };
  if (base === local) return { clean: true, text: remote };
  const [b, l, r] = [lf(base), lf(local), lf(remote)];
  const eol = detectEol(local);
  if (l === r) return { clean: true, text: local };
  if (b === l) return { clean: true, text: withEol(r, eol) };
  if (b === r) return { clean: true, text: local };
  const regions = diff3Merge(l.split('\n'), b.split('\n'), r.split('\n'), { excludeFalseConflicts: true });
  const out: string[] = [];
  for (const region of regions) {
    if (region.conflict) return { clean: false, text: '' };
    if (region.ok) out.push(...region.ok);
  }
  return { clean: true, text: withEol(out.join('\n'), eol) };
}
