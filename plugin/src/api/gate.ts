import type { Clock } from '../util/clock';

/**
 * Remembers the latest Retry-After from the server. While it runs, the API
 * client refuses to send and the WebSocket client waits before reconnecting,
 * so a rate-limited device backs off everywhere at once.
 */
export class RateGate {
  private until = 0;

  constructor(private readonly clock: Clock) {}

  block(ms: number): void {
    this.until = Math.max(this.until, this.clock.now() + ms);
  }

  /** Milliseconds left to wait, 0 if open. */
  remainingMs(): number {
    return Math.max(0, this.until - this.clock.now());
  }
}
