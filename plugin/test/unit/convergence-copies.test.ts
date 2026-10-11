// The convergence harness's copy accounting (test/convergence/copies.ts).
import { describe, expect, it } from 'vitest';
import { CopyTracker } from '../convergence/copies';
import { caseFold } from '../../src/util/path';

const COPY = 'C (conflict dev1 2026-01-01 0038).md';
const exact = (p: string) => p;
/** A server that holds none of the copies live. */
const nowhere = () => Promise.resolve(false);

describe('CopyTracker', () => {
  it('counts a reported copy that is still there at the end', async () => {
    const t = new CopyTracker(exact);
    await t.scan(1, [COPY], nowhere);
    t.report({ path: COPY, device: 'dev0', step: 1, kind: 'collision' });
    expect(t.missing([COPY, 'C.md'])).toEqual([]);
  });

  it('reports a copy that is gone with no removal', async () => {
    const t = new CopyTracker(exact);
    await t.scan(1, [COPY], nowhere);
    t.report({ path: COPY, device: 'dev0', step: 1, kind: 'collision' });
    await t.scan(2, [], nowhere);
    expect(t.missing(['C.md']).map((c) => c.path)).toEqual([COPY]);
  });

  it('excuses a copy the harness removed after it appeared', async () => {
    const t = new CopyTracker(exact);
    await t.scan(1, [COPY], nowhere);
    t.report({ path: COPY, device: 'dev0', step: 1, kind: 'conflict' });
    t.removed(COPY, 3);
    await t.scan(3, [], nowhere);
    expect(t.missing([])).toEqual([]);
  });

  it('counts a removal from when the copy appeared, not from when an event named it', async () => {
    const t = new CopyTracker(exact);
    await t.scan(1, [COPY], nowhere); // appears on dev0, which does not report it
    t.removed(COPY, 2);
    await t.scan(2, [], nowhere);
    t.report({ path: COPY, device: 'dev2', step: 4, kind: 'collision' }); // dev2, offline until now, reports it late
    expect(t.missing([])).toEqual([]);
  });

  it('does not let a removal of an earlier copy excuse a new one of the same name', async () => {
    const t = new CopyTracker(exact);
    await t.scan(1, [COPY], nowhere);
    t.removed(COPY, 2);
    await t.scan(2, [], nowhere);
    await t.scan(5, [COPY], nowhere); // a new copy of that name
    t.report({ path: COPY, device: 'dev1', step: 5, kind: 'collision' });
    await t.scan(6, [], nowhere);
    expect(t.missing([]).map((c) => c.step)).toEqual([5]);
  });

  it('keeps the identity of a copy that only the server holds for a while', async () => {
    // Nightly seeds 7466, 7481, 7754: dev0 saves a collision copy and pushes it, then the
    // user removes it before another device has pulled it. Until dev0 syncs again only the
    // server holds the copy. dev1 pulls it and reports it; then dev0's removal reaches
    // dev1. That removal came after the copy appeared, so it excuses the copy.
    const t = new CopyTracker(exact);
    let live = new Set<string>();
    const server = (paths: string[]) => Promise.resolve(paths.some((p) => live.has(p)));
    await t.scan(41, [COPY], server);
    t.report({ path: COPY, device: 'dev0', step: 41, kind: 'collision' });
    live = new Set([COPY]);
    t.removed(COPY, 42);
    await t.scan(42, [], server);
    await t.scan(43, [], server);
    await t.scan(45, [COPY], server);
    t.report({ path: COPY, device: 'dev1', step: 45, kind: 'collision' });
    live = new Set();
    await t.scan(60, [], server);
    expect(t.missing([])).toEqual([]);
  });

  it('asks the server about the spellings last seen on the devices', async () => {
    const t = new CopyTracker(caseFold);
    const asked: string[][] = [];
    await t.scan(1, [COPY], (paths) => Promise.resolve(asked.push(paths) < 0));
    await t.scan(2, [], (paths) => Promise.resolve(asked.push(paths) < 0));
    expect(asked).toEqual([[COPY]]);
  });

  it('compares names as the fleet does', async () => {
    const t = new CopyTracker(caseFold);
    await t.scan(1, [COPY], nowhere);
    t.report({ path: COPY, device: 'dev0', step: 1, kind: 'collision' });
    expect(t.missing([COPY.toLowerCase()])).toEqual([]);
  });
});
