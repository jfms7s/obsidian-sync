// The table of diff3 cases from spec §8.
import { describe, expect, it } from 'vitest';
import { detectEol, merge3 } from '../../src/merge/merge3';
import { decodeText } from '../../src/sync/content';
import { utf8 } from '../../src/util/bytes';

type Case = [name: string, base: string, local: string, remote: string, expected: string | null];

const cases: Case[] = [
  ['identical edits', 'a\n', 'b\n', 'b\n', 'b\n'],
  ['only local changed', 'a\nb\n', 'a\nB\n', 'a\nb\n', 'a\nB\n'],
  ['only remote changed', 'a\nb\n', 'a\nb\n', 'a\nB\n', 'a\nB\n'],
  ['separate hunks', 'a\nb\nc\nd\ne\n', 'A\nb\nc\nd\ne\n', 'a\nb\nc\nd\nE\n', 'A\nb\nc\nd\nE\n'],
  ['overlapping edit of one line', 'a\nb\nc\n', 'a\nX\nc\n', 'a\nY\nc\n', null],
  ['adjacent lines conflict (GNU diff3)', 'a\nb\nc\nd\n', 'a\nB\nc\nd\n', 'a\nb\nC\nd\n', null],
  ['insertions at the same place', 'a\nb\n', 'a\nX\nb\n', 'a\nY\nb\n', null],
  ['insertions far apart', 'a\nb\nc\nd\n', 'X\na\nb\nc\nd\n', 'a\nb\nc\nd\nY\n', 'X\na\nb\nc\nd\nY\n'],
  ['frontmatter key and body edited', '---\ntags: [a]\n---\n\n# T\n\nbody\n', '---\ntags: [a, b]\n---\n\n# T\n\nbody\n', '---\ntags: [a]\n---\n\n# T\n\nbody edited\n', '---\ntags: [a, b]\n---\n\n# T\n\nbody edited\n'],
  ['same frontmatter key edited differently', '---\nstatus: draft\n---\nx\n', '---\nstatus: done\n---\nx\n', '---\nstatus: review\n---\nx\n', null],
  ['empty base, both created the same', '', 'same\n', 'same\n', 'same\n'],
  ['empty base, both created differently', '', 'mine\n', 'theirs\n', null],
  ['empty local file vs remote edit', 'a\n', '', 'a\nb\n', null],
  ['local emptied, remote unchanged', 'a\n', '', 'a\n', ''],
  ['trailing newline added locally, line edited remotely', 'a\nb', 'a\nb\n', 'A\nb', 'A\nb\n'],
  ['trailing newline removed on one side only', 'a\nb\nc\n', 'a\nb\nc', 'A\nb\nc\n', 'A\nb\nc'],
  ['local deletes a line, remote edits a far one', 'a\nb\nc\nd\ne\n', 'a\nc\nd\ne\n', 'a\nb\nc\nd\nE\n', 'a\nc\nd\nE\n'],
];

describe('merge3', () => {
  it.each(cases)('%s', (_name, base, local, remote, expected) => {
    const r = merge3(base, local, remote);
    if (expected === null) expect(r.clean).toBe(false);
    else expect(r).toEqual({ clean: true, text: expected });
  });

  it('compares line endings normalized and writes local CRLF', () => {
    const r = merge3('a\nb\nc\nd\n', 'A\r\nb\r\nc\r\nd\r\n', 'a\nb\nc\nD\n');
    expect(r).toEqual({ clean: true, text: 'A\r\nb\r\nc\r\nD\r\n' });
  });

  it('keeps local bytes when the only difference is line endings', () => {
    expect(merge3('a\n', 'b\r\n', 'b\n')).toEqual({ clean: true, text: 'b\r\n' });
  });

  it('converts a remote-only change to local line endings', () => {
    expect(merge3('a\nb\n', 'a\r\nb\r\n', 'a\nB\n')).toEqual({ clean: true, text: 'a\r\nB\r\n' });
  });

  it('detects the dominant line ending', () => {
    expect(detectEol('a\r\nb\r\nc\n')).toBe('\r\n');
    expect(detectEol('a\nb\r\n')).toBe('\n');
    expect(detectEol('no newline')).toBe('\n');
  });
});

  it('keeps a byte-order mark through decode, merge and encode', () => {
    const bom = [0xef, 0xbb, 0xbf];
    const enc = (t: string) => new Uint8Array([...bom, ...utf8(t)]);
    const [base, local, remote] = ['a\nb\nc\nd\n', 'A\nb\nc\nd\n', 'a\nb\nc\nD\n'].map((t) => decodeText('n.md', enc(t))!);
    const m = merge3(base!, local!, remote!);
    expect(m.clean).toBe(true);
    expect(utf8(m.text)).toEqual(enc('A\nb\nc\nD\n'));
  });

  it('writes LF when local mixes line endings, rather than forcing the majority on every line', () => {
    expect(merge3('a\nb\nc\nd\n', 'A\r\nb\r\nc\nd\r\n', 'a\nb\nc\nD\n')).toEqual({ clean: true, text: 'A\nb\nc\nD\n' });
    expect(merge3('a\nb\n', 'a\r\nb\n', 'a\nB\n')).toEqual({ clean: true, text: 'a\nB\n' });
  });

  it('returns raw text when one side equals the base byte for byte', () => {
    expect(merge3('a\r\nb\n', 'a\r\nb\n', 'x\ny\r\n').text).toBe('x\ny\r\n');
    expect(merge3('a\r\nb\n', 'x\ny\r\n', 'a\r\nb\n').text).toBe('x\ny\r\n');
  });
