import { describe, expect, it, vi } from 'vitest';
import { ApiClient } from '../../src/api/client';
import { NetworkError } from '../../src/api/errors';
import { createRequestUrlTransport, type RequestFn, type RequestResult } from '../../src/shell/transport';
import { ManualClock } from '../../src/util/clock';

/** Lets promise callbacks run (the clock is manual, but promises settle on the real event loop). */
const flush = () => new Promise<void>((r) => setTimeout(r, 0));
const ok = (over: Partial<RequestResult> = {}): RequestResult => ({ status: 200, headers: {}, arrayBuffer: new ArrayBuffer(0), ...over });

describe('requestUrl transport', () => {
  it('sends the request without Obsidian throwing on error statuses, and moves Content-Type to its own parameter', async () => {
    const request = vi.fn<RequestFn>(async () => ok());
    const send = createRequestUrlTransport({ request });
    const whole = new Uint8Array([9, 1, 2, 3, 9]);
    await send('https://sync.example/v1/x', { method: 'POST', headers: { Authorization: 'Bearer t', 'Content-Type': 'application/x-protobuf' }, body: whole.subarray(1, 4) as Uint8Array<ArrayBuffer> });
    const p = request.mock.calls[0]![0];
    expect(p).toMatchObject({ url: 'https://sync.example/v1/x', method: 'POST', throw: false, contentType: 'application/x-protobuf' });
    expect(p.headers).toEqual({ Authorization: 'Bearer t' });
    // Exactly the bytes of the view, not the buffer behind it.
    expect([...new Uint8Array(p.body as ArrayBuffer)]).toEqual([1, 2, 3]);
  });

  it('answers with the status, a case-insensitive header lookup and the body', async () => {
    const body = new Uint8Array([5, 6]).buffer;
    const send = createRequestUrlTransport({ request: async () => ok({ status: 429, headers: { 'retry-after': '7', 'content-type': 'application/x-protobuf' }, arrayBuffer: body }) });
    const resp = await send('https://s/x', { method: 'GET', headers: {} });
    expect(resp.status).toBe(429);
    expect(resp.headers.get('Retry-After')).toBe('7');
    expect(resp.headers.get('CONTENT-TYPE')).toBe('application/x-protobuf');
    expect(resp.headers.get('X-Missing')).toBeNull();
    expect([...new Uint8Array(await resp.arrayBuffer())]).toEqual([5, 6]);
  });

  it('gives up on a request that never answers (requestUrl cannot be aborted), and ignores a late answer', async () => {
    const clock = new ManualClock();
    let answer!: (r: RequestResult) => void;
    const send = createRequestUrlTransport({ clock, request: () => new Promise((resolve) => (answer = resolve)) });
    const result = send('https://s/v1/auth/login', { method: 'POST', headers: {} }).then(() => 'answered', (e: unknown) => e);
    clock.advance(59_000);
    await Promise.resolve();
    clock.advance(1_000);
    expect(await result).toMatchObject({ message: expect.stringMatching(/timed out after 60 s/) });
    answer(ok()); // the abandoned request finishes later: nothing happens
    await Promise.resolve();
  });

  it('allows chunk transfers and big bodies much longer', async () => {
    for (const [url, body] of [['https://s/v1/vaults/0123456789abcdef0123456789abcdef/chunks/aa', undefined], ['https://s/v1/vaults/0123456789abcdef0123456789abcdef/commit', new Uint8Array(2 << 20)]] as const) {
      const clock = new ManualClock();
      const send = createRequestUrlTransport({ clock, request: () => new Promise(() => undefined) });
      const outcome: unknown[] = [];
      void send(url, { method: 'PUT', headers: {}, ...(body ? { body: body as Uint8Array<ArrayBuffer> } : {}) }).catch((e: unknown) => outcome.push(e));
      clock.advance(299_000);
      await flush();
      expect(outcome).toEqual([]);
      clock.advance(1_000);
      await flush();
      expect(outcome).toHaveLength(1);
    }
  });

  it('shows up in ApiClient as a NetworkError, which the engine treats as being offline', async () => {
    const clock = new ManualClock();
    const api = new ApiClient({ baseUrl: 'https://s', token: 't', clock, fetch: createRequestUrlTransport({ clock, request: () => new Promise(() => undefined) }) });
    const failure = api.listDevices().catch((e: unknown) => e);
    clock.advance(60_000);
    expect(await failure).toBeInstanceOf(NetworkError);
  });
});
