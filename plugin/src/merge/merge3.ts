// Three-way merge of text files (spec §5.5) on top of node-diff3, which
// follows GNU diff3: changes to the same or adjacent lines conflict.
import { diff3Merge } from 'node-diff3';

export type Eol = '\n' | '\r\n';

export interface MergeResult {
  /** false: overlapping changes; the caller keeps local and writes remote as a conflict copy. */
  clean: boolean;
  /** The merged text when clean, written with local's line endings (LF when local mixes them). */
  text: string;
}

/** CRLF if most line breaks in s are CRLF, else LF (also for text without line breaks). */
export function detectEol(s: string): Eol {
  const crlf = (s.match(/\r\n/g) ?? []).length;
  const lf = (s.match(/\n/g) ?? []).length - crlf;
  return crlf > lf ? '\r\n' : '\n';
}

/** The one line ending local uses throughout, or LF when it mixes them or has none. */
function uniformEol(s: string): Eol {
  const crlf = (s.match(/\r\n/g) ?? []).length;
  const lfOnly = (s.match(/\n/g) ?? []).length - crlf;
  return crlf > 0 && lfOnly === 0 ? '\r\n' : '\n';
}

function lf(s: string): string {
  return s.replace(/\r\n/g, '\n');
}

function withEol(s: string, eol: Eol): string {
  return eol === '\n' ? s : s.replace(/\n/g, '\r\n');
}

/**
 * Merges local and remote edits of base, deterministically:
 * 1. byte for byte: local = base → remote; remote = base → local; local = remote → local;
 * 2. otherwise line endings are normalized to LF for comparison, and the
 *    result is written in local's style if local uses one style throughout,
 *    else in LF (lines from a mixed file cannot keep their own endings
 *    through node-diff3, so none is preferred).
 * A trailing newline is an ordinary (empty last) line, so adding or
 * removing one is an edit like any other.
 */
export function merge3(base: string, local: string, remote: string): MergeResult {
  if (base === local) return { clean: true, text: remote };
  if (base === remote || local === remote) return { clean: true, text: local };
  const [b, l, r] = [lf(base), lf(local), lf(remote)];
  const eol = uniformEol(local);
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
