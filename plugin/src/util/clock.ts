// Time is injected so tests can control timers and timestamps.

export type TimerHandle = { readonly id: number };

export interface Clock {
  now(): number; // Unix milliseconds
  setTimeout(fn: () => void, ms: number): TimerHandle;
  clearTimeout(h: TimerHandle): void;
}

let nextId = 1;

// Obsidian can run the plugin in a pop-out window: timers belong to the window. Outside Obsidian (tests, tools) there is none.
const timers = typeof window !== 'undefined' ? window : { setTimeout, clearTimeout };

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout(fn, ms) {
    const h: unknown = timers.setTimeout(fn, ms);
    return { id: nextId++, h } as TimerHandle & { h: unknown };
  },
  clearTimeout(h) {
    timers.clearTimeout((h as TimerHandle & { h: number }).h);
  },
};

/** A clock that moves only when advance() is called. Timers fire in due order. */
export class ManualClock implements Clock {
  private t: number;
  private timers = new Map<number, { at: number; fn: () => void }>();

  constructor(startMs = Date.UTC(2026, 0, 2, 3, 4, 5)) {
    this.t = startMs;
  }

  now(): number {
    return this.t;
  }

  setTimeout(fn: () => void, ms: number): TimerHandle {
    const id = nextId++;
    this.timers.set(id, { at: this.t + Math.max(0, ms), fn });
    return { id };
  }

  clearTimeout(h: TimerHandle): void {
    this.timers.delete(h.id);
  }

  pendingTimers(): number {
    return this.timers.size;
  }

  advance(ms: number): void {
    const end = this.t + ms;
    for (;;) {
      let due: [number, { at: number; fn: () => void }] | undefined;
      for (const e of this.timers) if (e[1].at <= end && (!due || e[1].at < due[1].at)) due = e;
      if (!due) break;
      this.timers.delete(due[0]);
      this.t = due[1].at;
      due[1].fn();
    }
    this.t = end;
  }
}
