import { describe, expect, it } from 'vitest';
import { mergeJsonSettings } from '../../src/merge/json-merge';

const j = (o: unknown) => JSON.stringify(o, null, 2);
const m = (base: unknown, ours: unknown, theirs: unknown) => {
  const out = mergeJsonSettings(base === null ? null : j(base), j(ours), j(theirs));
  return out === null ? null : JSON.parse(out);
};

describe('mergeJsonSettings', () => {
  it('takes a key changed on one side from that side', () => {
    expect(m({ a: 1, b: 1 }, { a: 2, b: 1 }, { a: 1, b: 1 })).toEqual({ a: 2, b: 1 });
    expect(m({ a: 1, b: 1 }, { a: 1, b: 1 }, { a: 1, b: 3 })).toEqual({ a: 1, b: 3 });
    expect(m({ a: 1, b: 1 }, { a: 2, b: 1 }, { a: 1, b: 3 })).toEqual({ a: 2, b: 3 });
  });

  it('keeps a change made the same way on both sides', () => {
    expect(m({ a: 1 }, { a: { x: [1, 2] } }, { a: { x: [1, 2] } })).toEqual({ a: { x: [1, 2] } });
  });

  it('takes the remote value of a key changed differently on both sides', () => {
    expect(m({ theme: 'x' }, { theme: 'light' }, { theme: 'dark' })).toEqual({ theme: 'dark' });
    expect(m({ h: { k: ['Mod+A'] } }, { h: { k: ['Mod+B'] } }, { h: { k: ['Mod+C'] } })).toEqual({ h: { k: ['Mod+C'] } });
  });

  it('merges added and removed keys', () => {
    expect(m({ a: 1, b: 1 }, { a: 1, b: 1, c: 1 }, { a: 1 })).toEqual({ a: 1, c: 1 });
    expect(m({ a: 1, b: 1 }, { b: 1 }, { a: 1, b: 1, d: 4 })).toEqual({ b: 1, d: 4 });
    // Removed on one side, changed on the other: a change on both sides, the remote side wins.
    expect(m({ a: 1 }, {}, { a: 2 })).toEqual({ a: 2 });
    expect(m({ a: 1 }, { a: 2 }, {})).toEqual({});
  });

  it('treats a missing base as an empty object', () => {
    expect(m(null, { a: 1, mine: true }, { a: 2, theirs: true })).toEqual({ a: 2, theirs: true, mine: true });
  });

  it('compares values, not key order or formatting', () => {
    expect(mergeJsonSettings('{"a":{"x":1,"y":2}}', '{"a":{"y":2,"x":1},"b":1}', '{\n  "a": {"x": 1, "y": 2}\n}')).toBe(j({ a: { x: 1, y: 2 }, b: 1 }));
  });

  it.each([
    ['ours', '{"a":1}', 'not json', '{"a":2}'], ['theirs', '{"a":1}', '{"a":1}', '{"a":'], ['base', '[1]', '{"a":1}', '{"a":2}'],
    ['an array', '{}', '[]', '{}'], ['null', '{}', 'null', '{}'], ['a number', '{}', '{}', '3'],
  ])('refuses when %s is not a JSON object', (_, base, ours, theirs) => {
    expect(mergeJsonSettings(base, ours, theirs)).toBeNull();
  });

  it('always returns JSON, written as Obsidian writes it, theirs\' keys first', () => {
    const out = mergeJsonSettings('{"a":1,"b":1}', '{"b":2,"a":1,"z":0}', '{"a":3,"b":1}')!;
    expect(out).toBe('{\n  "a": 3,\n  "b": 2,\n  "z": 0\n}');
    expect(() => JSON.parse(out)).not.toThrow();
  });
});
