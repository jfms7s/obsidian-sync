// The engine's HTTP transport over Obsidian's requestUrl. requestUrl sends no
// CORS preflight (the server has no CORS), buffers whole bodies, and cannot be
// aborted, so a request that never answers (a captive portal, a dead
// connection a mobile OS keeps open) would hold the sync cycle forever. This
// transport therefore gives up after a timeout and ignores a late answer.
import { requestUrl, type RequestUrlParam } from 'obsidian';
import type { FetchLike, HttpResponse } from '../api/client';
import { systemClock, type Clock } from '../util/clock';

export interface RequestResult {
  status: number;
  /** Lower-case names, as requestUrl returns them. */
  headers: Record<string, string>;
  arrayBuffer: ArrayBuffer;
}

export type RequestFn = (param: RequestUrlParam) => Promise<RequestResult>;

export interface TransportOptions {
  request?: RequestFn;
  clock?: Clock;
  /** Most requests are small; this is how long they may take. */
  timeoutMs?: number;
  /** Chunk transfers and big commit bodies, over a slow mobile connection. */
  longTimeoutMs?: number;
}

export const DEFAULT_TIMEOUT_MS = 60_000;
export const DEFAULT_LONG_TIMEOUT_MS = 300_000;
const BIG_BODY_BYTES = 1 << 20;

function withTimeout<T>(call: Promise<T>, ms: number, clock: Clock, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = clock.setTimeout(() => reject(new Error(`${what} timed out after ${Math.round(ms / 1000)} s`)), ms);
    // Whichever settles first wins; the other is ignored, and the abandoned call's rejection is handled here.
    call.then(
      (v) => {
        clock.clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clock.clearTimeout(timer);
        reject(e);
      },
    );
  });
}

export function createRequestUrlTransport(o: TransportOptions = {}): FetchLike {
  const request: RequestFn = o.request ?? ((p) => requestUrl(p) as unknown as Promise<RequestResult>);
  const clock = o.clock ?? systemClock;
  const timeoutMs = o.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const longTimeoutMs = o.longTimeoutMs ?? DEFAULT_LONG_TIMEOUT_MS;
  return async (url, req): Promise<HttpResponse> => {
    const headers: Record<string, string> = {};
    let contentType: string | undefined;
    for (const [name, value] of Object.entries(req.headers)) {
      if (name.toLowerCase() === 'content-type') contentType = value;
      else headers[name] = value;
    }
    const param: RequestUrlParam = { url, method: req.method, headers, throw: false };
    if (contentType !== undefined) param.contentType = contentType;
    // A view into a larger buffer must not send the buffer behind it.
    if (req.body) param.body = req.body.buffer.slice(req.body.byteOffset, req.body.byteOffset + req.body.byteLength);
    const long = /\/chunks\/[0-9a-f]+$/.test(url) || (req.body?.byteLength ?? 0) > BIG_BODY_BYTES;
    const res = await withTimeout(request(param), long ? longTimeoutMs : timeoutMs, clock, `${req.method} ${new URL(url).pathname}`);
    return {
      status: res.status,
      headers: {
        get: (name) => {
          const want = name.toLowerCase();
          for (const [k, v] of Object.entries(res.headers)) if (k.toLowerCase() === want) return v;
          return null;
        },
      },
      arrayBuffer: () => Promise.resolve(res.arrayBuffer),
    };
  };
}
