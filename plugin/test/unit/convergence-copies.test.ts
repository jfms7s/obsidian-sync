// The convergence harness's copy accounting (test/convergence/copies.ts).
import { describe, expect, it } from 'vitest';
import { CopyTracker } from '../convergence/copies';
import { caseFold } from '../../src/util/path';

const COPY = 'C (conflict dev1 2026-01-01 0038).md';
const exact = (p: string) => p;

describe('CopyTracker', () => {
  it('counts a reported copy that is still there at the end', () => {
    const t = new CopyTracker(exact);
    t.scan(1, [COPY]);
    t.report({ path: COPY, device: 'dev0', step: 1, kind: 'collision' });
    expect(t.missing([COPY, 'C.md'])).toEqual([]);
  });

  it('reports a copy that is gone with no removal', () => {
    const t = new CopyTracker(exact);
    t.scan(1, [COPY]);
    t.report({ path: COPY, device: 'dev0', step: 1, kind: 'collision' });
    t.scan(2, []);
    expect(t.missing(['C.md']).map((c) => c.path)).toEqual([COPY]);
  });

  it('excuses a copy the harness removed after it appeared', () => {
    const t = new CopyTracker(exact);
    t.scan(1, [COPY]);
    t.report({ path: COPY, device: 'dev0', step: 1, kind: 'conflict' });
    t.removed(COPY, 3);
    t.scan(3, []);
    expect(t.missing([])).toEqual([]);
  });

  it('counts a removal from when the copy appeared, not from when an event named it', () => {
    const t = new CopyTracker(exact);
    t.scan(1, [COPY]); // appears on dev0, which does not report it
    t.removed(COPY, 2);
    t.scan(2, []);
    t.report({ path: COPY, device: 'dev2', step: 4, kind: 'collision' }); // dev2, offline until now, reports it late
    expect(t.missing([])).toEqual([]);
  });

  it('does not let a removal of an earlier copy excuse a new one of the same name', () => {
    const t = new CopyTracker(exact);
    t.scan(1, [COPY]);
    t.removed(COPY, 2);
    t.scan(2, []);
    t.scan(5, [COPY]); // a new copy of that name
    t.report({ path: COPY, device: 'dev1', step: 5, kind: 'collision' });
    t.scan(6, []);
    expect(t.missing([]).map((c) => c.step)).toEqual([5]);
  });

  it('compares names as the fleet does', () => {
    const t = new CopyTracker(caseFold);
    t.scan(1, [COPY]);
    t.report({ path: COPY, device: 'dev0', step: 1, kind: 'collision' });
    expect(t.missing([COPY.toLowerCase()])).toEqual([]);
  });
});
