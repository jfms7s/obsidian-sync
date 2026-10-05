// The real-server harness itself: the URL it hands out must be the one the
// spawned process bound, never a port another process grabbed in between.
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, inject, it } from 'vitest';
import { ApiClient } from '../../src/api/client';
import { Net } from '../helpers/net';
import { startServer } from '../helpers/server';

const tmp = mkdtempSync(join(tmpdir(), 'obsync-fake-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function fakeBin(name: string, body: string): string {
  const p = join(tmp, name);
  writeFileSync(p, `#!${process.execPath}\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
}

it('uses the address the server reports, not the one it was asked for', async () => {
  // Ignores OBSYNC_LISTEN, binds its own port and logs it like obsync does.
  const bin = fakeBin('own-port', `
    const http = require('node:http');
    const s = http.createServer((req, res) => { res.statusCode = req.url === '/readyz' ? 200 : 404; res.end(); });
    s.listen(0, '127.0.0.1', () => {
      process.stderr.write(JSON.stringify({ level: 'INFO', msg: 'obsync listening', addr: '127.0.0.1:' + s.address().port }) + '\\n');
    });
    process.on('SIGTERM', () => process.exit(0));
  `);
  const srv = await startServer(bin);
  try {
    expect((await fetch(`${srv.url}/readyz`)).status).toBe(200);
  } finally {
    await srv.stop();
  }
}, 30_000);

it('fails when the server exits right after reporting ready', async () => {
  const bin = fakeBin('exits', `
    process.stderr.write(JSON.stringify({ level: 'ERROR', msg: 'listen: address already in use' }) + '\\n');
    process.exit(1);
  `);
  await expect(startServer(bin)).rejects.toThrow(/exited/);
}, 30_000);

it('gives concurrently started servers their own ports and data', async () => {
  const bin = inject('obsyncBin');
  const servers = await Promise.all(Array.from({ length: 4 }, () => startServer(bin)));
  try {
    expect(new Set(servers.map((s) => s.url)).size).toBe(4);
    await servers[0]!.createUser('only-here', 'only-here-password');
    await new ApiClient({ baseUrl: servers[0]!.url }).login('only-here', 'only-here-password', 'd', 'node');
    await expect(new ApiClient({ baseUrl: servers[1]!.url }).login('only-here', 'only-here-password', 'd', 'node')).rejects.toThrow();
  } finally {
    await Promise.all(servers.map((s) => s.stop()));
  }
}, 60_000);

it('forgets a WebSocket once it has closed', async () => {
  const srv = await startServer(inject('obsyncBin'));
  try {
    const net = new Net();
    const ws = net.webSocket(srv.url.replace('http', 'ws') + '/v1/ws');
    ws.onclose = () => undefined; // the hub client sets this; the harness must not depend on it
    await new Promise<void>((resolve) => { ws.onopen = () => resolve(); });
    expect(net.openSockets).toBe(1);
    ws.close();
    const end = Date.now() + 5000;
    while (net.openSockets > 0 && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
    expect(net.openSockets).toBe(0);
  } finally {
    await srv.stop();
  }
}, 30_000);
