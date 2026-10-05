import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import { describe, expect, it } from 'vitest';
import { ApiClient, parseRetryAfter, type FetchLike } from '../../src/api/client';
import { ApiError, ErrorCode, isTemporary, NetworkError } from '../../src/api/errors';
import { InsecureServerUrlError, hubUrl, normalizeServerUrl } from '../../src/api/url';
import { ChangesResponseSchema, CommitRequestSchema, ErrorSchema, KeyBundleSchema } from '../../src/gen/obsync/v1/obsync_pb';
import { ManualClock } from '../../src/util/clock';

interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Uint8Array | null;
}

function mock(respond: (req: Seen) => Response): { fetch: FetchLike; seen: Seen[] } {
  const seen: Seen[] = [];
  return {
    seen,
    fetch: async (url, init) => {
      const req: Seen = { url, method: init.method, headers: { ...init.headers }, body: init.body ?? null };
      seen.push(req);
      return respond(req);
    },
  };
}

function protoResponse(status: number, body: Uint8Array, headers: Record<string, string> = {}): Response {
  return new Response(body.length ? (body as Uint8Array<ArrayBuffer>) : null, { status, headers: { 'Content-Type': 'application/x-protobuf', ...headers } });
}

function errorResponse(status: number, code: ErrorCode, message: string, headers: Record<string, string> = {}): Response {
  return protoResponse(status, toBinary(ErrorSchema, create(ErrorSchema, { code, message })), headers);
}

describe('server URLs', () => {
  it('requires https except on localhost', () => {
    expect(normalizeServerUrl('https://sync.example.com/')).toBe('https://sync.example.com');
    expect(normalizeServerUrl('http://localhost:8080')).toBe('http://localhost:8080');
    expect(normalizeServerUrl('http://127.0.0.1:8080/')).toBe('http://127.0.0.1:8080');
    expect(() => normalizeServerUrl('http://sync.example.com')).toThrow(InsecureServerUrlError);
    expect(() => normalizeServerUrl('https://u:p@sync.example.com')).toThrow();
    expect(hubUrl('https://sync.example.com/obsync')).toBe('wss://sync.example.com/obsync/v1/ws');
  });
});

describe('ApiClient', () => {
  it('labels protobuf and chunk bodies and sends the bearer token', async () => {
    const m = mock(() => new Response(null, { status: 204 }));
    const api = new ApiClient({ baseUrl: 'https://s', token: 'tok', fetch: m.fetch });
    await api.putChunk('0123456789abcdef0123456789abcdef', new Uint8Array(32).fill(0xab), new Uint8Array([1, 2]));
    await api.putKeyBundle({ publicEncKey: new Uint8Array(32), publicSignKey: new Uint8Array(32), passSalt: new Uint8Array(16), passParams: { memoryKib: 8192, iterations: 1, parallelism: 1 }, passWrapped: new Uint8Array(1), recoveryWrapped: new Uint8Array(1) }, 'login pw');
    expect(m.seen[0]).toMatchObject({ method: 'PUT', url: `https://s/v1/vaults/0123456789abcdef0123456789abcdef/chunks/${'ab'.repeat(32)}` });
    expect(m.seen[0]!.headers).toMatchObject({ 'Content-Type': 'application/octet-stream', Authorization: 'Bearer tok' });
    expect(m.seen[1]!.headers['Content-Type']).toBe('application/x-protobuf');
    expect(fromBinary(KeyBundleSchema, m.seen[1]!.body!).currentPassword).toBe('login pw');
  });

  it('decodes protobuf errors with their code', async () => {
    const m = mock(() => errorResponse(403, ErrorCode.WRONG_PASSWORD, 'wrong account password'));
    const api = new ApiClient({ baseUrl: 'https://s', token: 't', fetch: m.fetch });
    const err = await api.listVaults().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ code: ErrorCode.WRONG_PASSWORD, status: 403, message: 'wrong account password' });
  });

  it('maps a proxy error page to a code from its status', async () => {
    const m = mock(() => new Response('<html>bad gateway</html>', { status: 502, headers: { 'Content-Type': 'text/html' } }));
    const err = await new ApiClient({ baseUrl: 'https://s', token: 't', fetch: m.fetch }).listVaults().catch((e: unknown) => e);
    expect(err).toMatchObject({ code: ErrorCode.INTERNAL, status: 502 });
    expect(isTemporary(err)).toBe(true);
  });

  it('honours Retry-After on 429 by refusing to send until it has passed', async () => {
    const clock = new ManualClock(0);
    const m = mock(() => errorResponse(429, ErrorCode.RATE_LIMITED, 'slow down', { 'Retry-After': '7' }));
    const api = new ApiClient({ baseUrl: 'https://s', token: 't', fetch: m.fetch, clock });
    await expect(api.listVaults()).rejects.toMatchObject({ code: ErrorCode.RATE_LIMITED, retryAfterMs: 7000 });
    await expect(api.listVaults()).rejects.toMatchObject({ code: ErrorCode.RATE_LIMITED, retryAfterMs: 7000 });
    expect(m.seen).toHaveLength(1);
    clock.advance(7000);
    await expect(api.listVaults()).rejects.toMatchObject({ code: ErrorCode.RATE_LIMITED });
    expect(m.seen).toHaveLength(2);
  });

  it('works over a minimal transport like Obsidian requestUrl (lower-case headers, plain objects)', async () => {
    // What plan 3's adapter returns: status, a header lookup and the body; nothing fetch-specific.
    const transport: FetchLike = async () => {
      const headers: Record<string, string> = { 'content-type': 'application/octet-stream', 'content-length': '3' };
      return { status: 200, headers: { get: (n: string) => headers[n.toLowerCase()] ?? null }, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };
    };
    const api = new ApiClient({ baseUrl: 'https://s', token: 't', fetch: transport });
    expect(await api.getChunk('0123456789abcdef0123456789abcdef', new Uint8Array(32))).toEqual(new Uint8Array([1, 2, 3]));
    const limited: FetchLike = async () => {
      const headers: Record<string, string> = { 'retry-after': '4' };
      return { status: 429, headers: { get: (n: string) => headers[n.toLowerCase()] ?? null }, arrayBuffer: async () => new ArrayBuffer(0) };
    };
    await expect(new ApiClient({ baseUrl: 'https://s', token: 't', fetch: limited }).listVaults()).rejects.toMatchObject({ code: ErrorCode.RATE_LIMITED, retryAfterMs: 4000 });
  });

  it('treats a 429 without Retry-After as temporary with no gate', async () => {
    const m = mock(() => errorResponse(429, ErrorCode.RATE_LIMITED, 'too many password checks'));
    const api = new ApiClient({ baseUrl: 'https://s', fetch: m.fetch });
    const err = await api.login('u', 'p', 'd', 'x').catch((e: unknown) => e);
    expect(err).toMatchObject({ code: ErrorCode.RATE_LIMITED, retryAfterMs: undefined });
    expect(api.gate.remainingMs()).toBe(0);
  });

  it('parses Retry-After as seconds or an HTTP date', () => {
    expect(parseRetryAfter('3', 0)).toBe(3000);
    expect(parseRetryAfter('Thu, 01 Jan 1970 00:00:10 GMT', 4000)).toBe(6000);
    expect(parseRetryAfter('soon', 0)).toBeUndefined();
    expect(parseRetryAfter(null, 0)).toBeUndefined();
  });

  it('turns transport failures and short chunk bodies into NetworkError', async () => {
    const down = new ApiClient({ baseUrl: 'https://s', token: 't', fetch: async () => { throw new TypeError('fetch failed'); } });
    await expect(down.listVaults()).rejects.toBeInstanceOf(NetworkError);
    const short = mock(() => new Response(new Uint8Array([1, 2]), { status: 200, headers: { 'Content-Length': '5' } }));
    const api = new ApiClient({ baseUrl: 'https://s', token: 't', fetch: short.fetch });
    await expect(api.getChunk('0123456789abcdef0123456789abcdef', new Uint8Array(32))).rejects.toBeInstanceOf(NetworkError);
  });

  it('reports a missing key bundle as null', async () => {
    const m = mock(() => errorResponse(404, ErrorCode.NOT_FOUND, 'no key bundle has been uploaded yet'));
    expect(await new ApiClient({ baseUrl: 'https://s', token: 't', fetch: m.fetch }).getKeyBundle()).toBeNull();
  });

  it('sends commits and converts 64-bit fields', async () => {
    const m = mock((req) => {
      if (req.url.includes('/commit')) {
        expect(fromBinary(CommitRequestSchema, req.body!).commits[0]!.size).toBe(5n);
        return protoResponse(200, new Uint8Array(0));
      }
      return protoResponse(200, toBinary(ChangesResponseSchema, create(ChangesResponseSchema, { vaultSeq: 9n, more: true })));
    });
    const api = new ApiClient({ baseUrl: 'https://s', token: 't', fetch: m.fetch });
    await expect(api.commit('0123456789abcdef0123456789abcdef', [{ fileId: new Uint8Array(32), versionId: new Uint8Array(16), baseVersionId: new Uint8Array(0), epoch: 1, encMeta: new Uint8Array(1), chunkIds: [], size: 5, deleted: false }]))
      .rejects.toBeInstanceOf(NetworkError); // zero results for one commit
    expect(await api.changes('0123456789abcdef0123456789abcdef', 3)).toEqual({ versions: [], vaultSeq: 9, more: true });
    expect(m.seen[1]!.url).toBe('https://s/v1/vaults/0123456789abcdef0123456789abcdef/changes?since=3&limit=1000');
  });
});
