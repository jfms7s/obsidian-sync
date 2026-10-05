// A switchable, fault-injecting network in front of the real server.
import { fetchTransport, type FetchLike } from '../../src/api/client';
import type { WebSocketFactory, WebSocketLike } from '../../src/api/hub';

export interface RequestLog {
  method: string;
  path: string;
}

export class Net {
  online = true;
  /** Requests whose response is thrown away after the server handled them. */
  private loseResponses: Array<(method: string, path: string) => boolean> = [];
  readonly log: RequestLog[] = [];
  private sockets = new Set<WebSocketLike>();

  readonly fetch: FetchLike = async (input, req) => {
    const url = new URL(input);
    const method = req.method;
    if (!this.online) throw new TypeError('fetch failed: network is down');
    this.log.push({ method, path: url.pathname });
    const resp = await fetchTransport(input, req);
    const i = this.loseResponses.findIndex((f) => f(method, url.pathname));
    if (i >= 0) {
      this.loseResponses.splice(i, 1);
      await resp.arrayBuffer().catch(() => undefined);
      throw new TypeError('fetch failed: connection reset');
    }
    return resp;
  };

  readonly webSocket: WebSocketFactory = (url) => {
    if (!this.online) throw new Error('network is down');
    const ws = new WebSocket(url) as unknown as WebSocketLike;
    this.sockets.add(ws);
    return ws;
  };

  /** The next request matching method and a path suffix reaches the server, but its response is lost. */
  loseNextResponse(method: string, pathSuffix: string): void {
    this.loseResponses.push((m, p) => m === method && p.endsWith(pathSuffix));
  }

  setOnline(online: boolean): void {
    this.online = online;
    if (!online) {
      for (const ws of this.sockets) {
        try {
          ws.close();
        } catch {
          // ignore
        }
      }
      this.sockets.clear();
    }
  }

  count(method: string, pathPart: string): number {
    return this.log.filter((r) => r.method === method && r.path.includes(pathPart)).length;
  }
}
