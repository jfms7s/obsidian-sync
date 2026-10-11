// systemClock looks its timers up when they are set, not when the module
// loads: Obsidian may run the plugin in a pop-out window whose timers belong
// to that window, and tests that switch to fake timers expect them to apply.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { systemClock } from '../../src/util/clock';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('systemClock', () => {
  it('uses fake timers switched on after the module loaded', () => {
    vi.useFakeTimers();
    const fired = vi.fn();
    const h = systemClock.setTimeout(fired, 1_000);
    vi.advanceTimersByTime(999);
    expect(fired).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fired).toHaveBeenCalledOnce();
    const cancelled = vi.fn();
    systemClock.clearTimeout(systemClock.setTimeout(cancelled, 10));
    vi.advanceTimersByTime(10);
    expect(cancelled).not.toHaveBeenCalled();
    expect(h.id).toBeGreaterThan(0);
  });

  it("uses the window's timers when there is a window", () => {
    const setTimeout = vi.fn(() => 42);
    const clearTimeout = vi.fn();
    vi.stubGlobal('window', { setTimeout, clearTimeout });
    const fn = () => undefined;
    const h = systemClock.setTimeout(fn, 5);
    expect(setTimeout).toHaveBeenCalledWith(fn, 5);
    systemClock.clearTimeout(h);
    expect(clearTimeout).toHaveBeenCalledWith(42);
  });
});
