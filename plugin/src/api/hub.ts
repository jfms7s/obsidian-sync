// WebSocket client for the hub (server/internal/hub): Auth first, then
// Subscribe, Ping every 30 s, reconnect with backoff (spec §5.4, §7.5).
import { create, fromBinary, toBinary, type MessageInitShape } from '@bufbuild/protobuf';
import { ClientFrameSchema, ErrorCode, ServerFrameSchema } from '../gen/obsync/v1/obsync_pb';
import { backoffDelay, type BackoffPolicy, DEFAULT_BACKOFF } from '../util/backoff';
import type { Clock, TimerHandle } from '../util/clock';
import type { Random } from '../util/random';
import type { RateGate } from './gate';

/** The subset of the WebSocket API the hub client uses (browser, Obsidian and Node 22 all provide it). */
export interface WebSocketLike {
  binaryType: string;
  readonly readyState: number;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  send(data: Uint8Array<ArrayBuffer>): void;
  close(code?: number, reason?: string): void;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

export const PING_INTERVAL_MS = 30_000;
/** A socket that answers nothing for this long after a Ping is treated as dead. */
export const PONG_TIMEOUT_MS = 15_000;

export interface HubHandlers {
  onNotify(vaultId: string, seq: number): void;
  /** Authenticated and subscribed (also after every reconnect: time to reconcile). */
  onConnected(): void;
  onDisconnected(): void;
  /** DEVICE_REVOKED or UNAUTHORIZED: the client has stopped and will not reconnect. */
  onAuthFailure(code: ErrorCode, message: string): void;
  /** NOT_FOUND "vault not found": a subscribed vault is gone or access was removed. */
  onVaultNotFound(): void;
}

export interface HubOptions {
  url: string;
  token: string;
  vaultIds: string[];
  connect: WebSocketFactory;
  clock: Clock;
  random: Random;
  gate?: RateGate;
  backoff?: BackoffPolicy;
  pingIntervalMs?: number;
  pongTimeoutMs?: number;
}

export function defaultWebSocketFactory(url: string): WebSocketLike {
  return new WebSocket(url) as unknown as WebSocketLike;
}

export class HubClient {
  private ws: WebSocketLike | null = null;
  private stopped = true;
  private attempt = 0;
  private authed = false;
  private nonce = 0;
  private reconnectTimer: TimerHandle | null = null;
  private pingTimer: TimerHandle | null = null;
  private pongTimer: TimerHandle | null = null;
  private lastSeq = new Map<string, number>();

  constructor(private readonly opts: HubOptions, private readonly handlers: HubHandlers) {}

  get connected(): boolean {
    return this.authed;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onclose = ws.onmessage = ws.onerror = ws.onopen = null;
      try {
        ws.close(1000, 'client stopping');
      } catch {
        // already closed
      }
    }
    if (this.authed) {
      this.authed = false;
      this.handlers.onDisconnected();
    }
  }

  private clearTimers(): void {
    for (const t of [this.reconnectTimer, this.pingTimer, this.pongTimer]) if (t) this.opts.clock.clearTimeout(t);
    this.reconnectTimer = this.pingTimer = this.pongTimer = null;
  }

  private send(frame: MessageInitShape<typeof ClientFrameSchema>['frame']): void {
    this.ws?.send(toBinary(ClientFrameSchema, create(ClientFrameSchema, { frame })) as Uint8Array<ArrayBuffer>);
  }

  private connect(): void {
    if (this.stopped) return;
    let ws: WebSocketLike;
    try {
      ws = this.opts.connect(this.opts.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => this.send({ case: 'auth', value: { token: this.opts.token } });
    ws.onmessage = (ev) => this.onMessage(ev.data);
    ws.onerror = () => {
      // onclose follows and reconnects.
    };
    ws.onclose = () => this.onClose(ws);
  }

  private onClose(ws: WebSocketLike): void {
    if (ws !== this.ws) return;
    this.ws = null;
    this.clearTimers();
    if (this.authed) {
      this.authed = false;
      this.handlers.onDisconnected();
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    const delay = backoffDelay(this.attempt++, this.opts.random, this.opts.backoff ?? DEFAULT_BACKOFF, this.opts.gate?.remainingMs() ?? 0);
    this.reconnectTimer = this.opts.clock.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private schedulePing(): void {
    this.pingTimer = this.opts.clock.setTimeout(() => {
      this.pingTimer = null;
      this.send({ case: 'ping', value: { nonce: BigInt(++this.nonce) } });
      this.pongTimer = this.opts.clock.setTimeout(() => {
        // No answer: the connection is half-open. Closing triggers a reconnect.
        this.pongTimer = null;
        const ws = this.ws;
        if (ws) {
          try {
            ws.close(4000, 'pong timeout');
          } catch {
            // ignore
          }
          this.onClose(ws);
        }
      }, this.opts.pongTimeoutMs ?? PONG_TIMEOUT_MS);
    }, this.opts.pingIntervalMs ?? PING_INTERVAL_MS);
  }

  private onMessage(data: unknown): void {
    if (!(data instanceof ArrayBuffer)) return;
    let frame;
    try {
      frame = fromBinary(ServerFrameSchema, new Uint8Array(data));
    } catch {
      return;
    }
    if (this.pongTimer) {
      // Any frame proves the connection is alive.
      this.opts.clock.clearTimeout(this.pongTimer);
      this.pongTimer = null;
    }
    const f = frame.frame;
    switch (f.case) {
      case 'authOk':
        this.authed = true;
        this.attempt = 0;
        this.lastSeq.clear();
        this.send({ case: 'subscribe', value: { vaultIds: this.opts.vaultIds } });
        this.schedulePing();
        this.handlers.onConnected();
        break;
      case 'notify': {
        const seq = Number(f.value.seq);
        // The server keeps notifications monotonic per vault; this guards anyway.
        if (seq > (this.lastSeq.get(f.value.vaultId) ?? -1)) {
          this.lastSeq.set(f.value.vaultId, seq);
          this.handlers.onNotify(f.value.vaultId, seq);
        }
        break;
      }
      case 'pong':
        this.schedulePing();
        break;
      case 'error': {
        const { code, message } = f.value;
        if (code === ErrorCode.DEVICE_REVOKED || code === ErrorCode.UNAUTHORIZED) {
          this.stop();
          this.handlers.onAuthFailure(code, message);
        } else if (code === ErrorCode.NOT_FOUND) {
          this.handlers.onVaultNotFound();
        }
        // RATE_LIMITED and other errors are followed by the server closing
        // the socket; onclose reconnects with backoff.
        break;
      }
      default:
        break;
    }
  }
}
