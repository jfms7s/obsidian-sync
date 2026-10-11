// The plugin's heartbeat that obsync-cli pauses for (spec D4).
import { describe, expect, it } from 'vitest';
import { HEARTBEAT_INTERVAL_MS, HEARTBEAT_STALE_MS, HEARTBEAT_STOP_WAIT_MS, isFresh, parseHeartbeat, startHeartbeat, type HeartbeatSink } from '../../src/shell/heartbeat';
import { ManualClock } from '../../src/util/clock';

function sink() {
  const s = { text: null as string | null, writes: 0, fail: false };
  const value: HeartbeatSink = {
    write: async (t) => {
      if (s.fail) throw new Error('disk full');
      s.writes++;
      s.text = t;
    },
    remove: async () => {
      s.text = null;
    },
  };
  return { s, value };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('heartbeat', () => {
  it('is written at once and every interval, and removed when stopped', async () => {
    const clock = new ManualClock(1_000_000);
    const { s, value } = sink();
    const stop = startHeartbeat(value, clock, 'Laptop');
    await flush();
    expect(parseHeartbeat(s.text!)).toEqual({ obsync: 1, at: 1_000_000, device: 'Laptop' });
    clock.advance(HEARTBEAT_INTERVAL_MS);
    await flush();
    expect(s.writes).toBe(2);
    expect(parseHeartbeat(s.text!)!.at).toBe(1_000_000 + HEARTBEAT_INTERVAL_MS);
    await stop();
    expect(s.text).toBeNull();
    clock.advance(HEARTBEAT_INTERVAL_MS * 3);
    await flush();
    expect(s.writes).toBe(2);
    expect(clock.pendingTimers()).toBe(0);
  });

  it('stops without waiting for a write that never settles', async () => {
    const clock = new ManualClock(0);
    let removed = false;
    const stop = startHeartbeat({ write: () => new Promise(() => undefined), remove: async () => void (removed = true) }, clock, 'Laptop');
    await flush();
    const stopping = stop();
    await flush();
    expect(removed).toBe(false);
    clock.advance(HEARTBEAT_STOP_WAIT_MS);
    await stopping;
    expect(removed).toBe(true);
    expect(clock.pendingTimers()).toBe(0);
  });

  it('keeps beating after a failed write', async () => {
    const clock = new ManualClock(0);
    const { s, value } = sink();
    s.fail = true;
    const stop = startHeartbeat(value, clock, 'Laptop');
    await flush();
    s.fail = false;
    clock.advance(HEARTBEAT_INTERVAL_MS);
    await flush();
    expect(s.writes).toBe(1);
    await stop();
  });

  it('is fresh until it is HEARTBEAT_STALE_MS old; anything else is no heartbeat', () => {
    const hb = parseHeartbeat(JSON.stringify({ obsync: 1, at: 5000, device: 'x' }))!;
    expect(isFresh(hb, 5000 + HEARTBEAT_STALE_MS - 1)).toBe(true);
    expect(isFresh(hb, 5000 + HEARTBEAT_STALE_MS)).toBe(false);
    expect(isFresh(hb, 0)).toBe(true); // written a little "later" than now: a clock set back
    expect(isFresh(hb, 5000 - HEARTBEAT_STALE_MS)).toBe(false); // far in the future: not believed
    for (const bad of ['', 'not json', '{}', '{"obsync":2,"at":1}', '{"obsync":1,"at":"soon"}', 'null']) expect(parseHeartbeat(bad)).toBeNull();
  });
});
