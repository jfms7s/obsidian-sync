import { create, fromBinary, toBinary, type MessageInitShape } from '@bufbuild/protobuf';
import { describe, expect, it } from 'vitest';
import { RateGate } from '../../src/api/gate';
import { HubClient, type HubHandlers, type WebSocketLike } from '../../src/api/hub';
import { ClientFrameSchema, ErrorCode, ServerFrameSchema } from '../../src/gen/obsync/v1/obsync_pb';
import { ManualClock } from '../../src/util/clock';
import { seededRandom } from '../../src/util/random';

class FakeSocket implements WebSocketLike {
  binaryType = 'blob';
  readyState = 0;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  sent: Array<MessageInitShape<typeof ClientFrameSchema>['frame']> = [];
  closed = false;
  send(data: Uint8Array): void {
    this.sent.push(fromBinary(ClientFrameSchema, data).frame);
  }
  close(): void {
    this.closed = true;
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }
  serverSends(frame: MessageInitShape<typeof ServerFrameSchema>['frame']): void {
    const b = toBinary(ServerFrameSchema, create(ServerFrameSchema, { frame }));
    this.onmessage?.({ data: b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) });
  }
  serverCloses(): void {
    this.onclose?.({});
  }
}

function setup(withGate = false) {
  const clock = new ManualClock(0);
  const gate = withGate ? new RateGate(clock) : undefined;
  const sockets: FakeSocket[] = [];
  const calls: string[] = [];
  const handlers: HubHandlers = {
    onNotify: (v, s) => calls.push(`notify ${v} ${s}`),
    onConnected: () => calls.push('connected'),
    onDisconnected: () => calls.push('disconnected'),
    onAuthFailure: (c) => calls.push(`auth ${ErrorCode[c]}`),
    onVaultNotFound: () => calls.push('vault lost'),
  };
  const hub = new HubClient({
    url: 'ws://x/v1/ws', token: 'tok', vaultIds: ['v1'], clock, random: seededRandom(1),
    connect: () => { const s = new FakeSocket(); sockets.push(s); return s; },
    backoff: { baseMs: 1000, maxMs: 8000 }, ...(gate ? { gate } : {}),
  }, handlers);
  return { clock, sockets, calls, hub, gate };
}

describe('HubClient', () => {
  it('authenticates first, subscribes after AuthOk, and forwards increasing seqs', () => {
    const { sockets, calls, hub } = setup();
    hub.start();
    const s = sockets[0]!;
    s.open();
    expect(s.binaryType).toBe('arraybuffer');
    expect(s.sent).toEqual([{ case: 'auth', value: expect.objectContaining({ token: 'tok' }) }]);
    s.serverSends({ case: 'authOk', value: { deviceId: 'd' } });
    expect(s.sent[1]).toEqual({ case: 'subscribe', value: expect.objectContaining({ vaultIds: ['v1'] }) });
    s.serverSends({ case: 'notify', value: { vaultId: 'v1', seq: 5n } });
    s.serverSends({ case: 'notify', value: { vaultId: 'v1', seq: 4n } });
    s.serverSends({ case: 'notify', value: { vaultId: 'v1', seq: 6n } });
    expect(calls).toEqual(['connected', 'notify v1 5', 'notify v1 6']);
  });

  it('pings every 30 s and reconnects when no answer comes', () => {
    const { clock, sockets, calls, hub } = setup();
    hub.start();
    sockets[0]!.open();
    sockets[0]!.serverSends({ case: 'authOk', value: {} });
    clock.advance(30_000);
    expect(sockets[0]!.sent.at(-1)).toEqual({ case: 'ping', value: expect.objectContaining({ nonce: 1n }) });
    sockets[0]!.serverSends({ case: 'pong', value: { nonce: 1n } });
    clock.advance(30_000);
    expect(sockets[0]!.sent.at(-1)).toEqual({ case: 'ping', value: expect.objectContaining({ nonce: 2n }) });
    clock.advance(15_000); // no pong
    expect(sockets[0]!.closed).toBe(true);
    expect(calls).toContain('disconnected');
    clock.advance(1000);
    expect(sockets).toHaveLength(2);
  });

  it('detects a dead connection after a Ping answered only by a Notify', () => {
    const { clock, sockets, calls, hub } = setup();
    hub.start();
    sockets[0]!.open();
    sockets[0]!.serverSends({ case: 'authOk', value: {} });
    clock.advance(30_000); // ping 1
    sockets[0]!.serverSends({ case: 'notify', value: { vaultId: 'v1', seq: 1n } });
    clock.advance(60_000); // silence: no pong, no further frames
    expect(sockets[0]!.closed).toBe(true);
    expect(calls).toContain('disconnected');
    clock.advance(1000);
    expect(sockets).toHaveLength(2);
  });

  it('detaches the old socket when the pong times out, so its late close is ignored', () => {
    const { clock, sockets, calls, hub } = setup();
    hub.start();
    sockets[0]!.open();
    sockets[0]!.serverSends({ case: 'authOk', value: {} });
    clock.advance(45_000);
    expect(sockets[0]!.onclose).toBeNull();
    expect(sockets[0]!.onmessage).toBeNull();
    expect(calls.filter((c) => c === 'disconnected')).toHaveLength(1);
  });

  it('waits out a Retry-After before the first connection too', () => {
    const { clock, sockets, hub, gate } = setup(true);
    gate!.block(10_000);
    hub.start();
    expect(sockets).toHaveLength(0);
    clock.advance(9_999);
    expect(sockets).toHaveLength(0);
    clock.advance(1);
    expect(sockets).toHaveLength(1);
  });

  it('ignores a notify whose seq a number cannot hold exactly', () => {
    const { sockets, calls, hub } = setup();
    hub.start();
    sockets[0]!.open();
    sockets[0]!.serverSends({ case: 'authOk', value: {} });
    sockets[0]!.serverSends({ case: 'notify', value: { vaultId: 'v1', seq: 2n ** 53n + 1n } });
    expect(calls).toEqual(['connected']);
  });

  it('backs off exponentially between failed connections and waits out a Retry-After', () => {
    const { clock, sockets, hub, gate } = setup(true);
    hub.start();
    sockets[0]!.serverCloses(); // attempt 0: 500..1000 ms
    clock.advance(999);
    expect(sockets).toHaveLength(2);
    sockets[1]!.serverCloses(); // attempt 1: 1000..2000 ms
    clock.advance(999);
    expect(sockets).toHaveLength(2);
    clock.advance(1001);
    expect(sockets).toHaveLength(3);
    gate!.block(60_000);
    sockets[2]!.serverCloses();
    clock.advance(59_000);
    expect(sockets).toHaveLength(3);
    clock.advance(1000);
    expect(sockets).toHaveLength(4);
  });

  it('stops for good on DEVICE_REVOKED', () => {
    const { clock, sockets, calls, hub } = setup();
    hub.start();
    sockets[0]!.open();
    sockets[0]!.serverSends({ case: 'authOk', value: {} });
    sockets[0]!.serverSends({ case: 'error', value: { code: ErrorCode.DEVICE_REVOKED, message: 'revoked' } });
    sockets[0]!.serverCloses();
    clock.advance(600_000);
    expect(sockets).toHaveLength(1);
    expect(calls).toContain('auth DEVICE_REVOKED');
  });

  it('reports a lost vault and keeps the socket open', () => {
    const { sockets, calls, hub } = setup();
    hub.start();
    sockets[0]!.open();
    sockets[0]!.serverSends({ case: 'authOk', value: {} });
    sockets[0]!.serverSends({ case: 'error', value: { code: ErrorCode.NOT_FOUND, message: 'vault not found' } });
    expect(calls).toEqual(['connected', 'vault lost']);
    expect(sockets[0]!.closed).toBe(false);
  });
});
