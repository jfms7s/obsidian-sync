// Simulated devices running the real engine (no UI): a fixture Device plus
// a SyncEngine over the same state, adapter and network.
import { SyncEngine } from '../../src/sync/engine';
import { IgnoreRules } from '../../src/vault/ignore';
import { newDevice, type Device, type DeviceOptions, type User } from './fixture';
import type { TestServer } from './server';

export interface SimClient extends Device {
  engine: SyncEngine;
  /** The device's ignore globs; setIgnore changes them. */
  ignoreGlobs: string[];
  /** A fresh engine over the same state and adapter, as after an app restart. */
  restart(): Promise<void>;
  /** Changes the ignore globs and restarts the engine, as the settings tab does. */
  setIgnore(globs: string[]): Promise<void>;
}

export interface ClientOptions extends DeviceOptions {
  /** Default false: the test drives cycles with engine.runCycle(). */
  autoRun?: boolean;
  /** Default false: no hub WebSocket. */
  webSocket?: boolean;
}

export async function makeClient(srv: TestServer, user: User, o: ClientOptions): Promise<SimClient> {
  const dev = await newDevice(srv, user, o);
  let ignoreGlobs = [...(o.ignoreGlobs ?? [])];
  const build = () => {
    const engine = new SyncEngine({
      api: dev.api, state: dev.state, adapter: dev.adapter, ring: dev.ring, deviceName: dev.name, clock: dev.clock,
      random: dev.random, ignore: new IgnoreRules(ignoreGlobs, { caseInsensitive: dev.adapter.caseInsensitive, configDir: '.obsidian' }), webSocket: o.webSocket ? dev.net.webSocket : null,
      autoRun: o.autoRun ?? false, backoff: { baseMs: 20, maxMs: 200 }, maxFileBytes: dev.ctx.maxFileBytes,
    });
    engine.on((e) => dev.events.push(e));
    return engine;
  };
  const client: SimClient = {
    ...dev,
    engine: build(),
    get ignoreGlobs() {
      return ignoreGlobs;
    },
    set ignoreGlobs(globs: string[]) {
      ignoreGlobs = globs;
    },
    setIgnore: async (globs) => {
      ignoreGlobs = [...globs];
      await client.restart();
    },
    restart: async () => {
      await client.engine.stop();
      client.engine = build();
      await client.engine.start();
    },
  };
  await client.engine.start();
  return client;
}

/** Runs cycles on every client, round-robin, until a full round changes nothing and nothing is queued. */
export async function settle(clients: SimClient[], maxRounds = 20): Promise<void> {
  for (let round = 0; round < maxRounds; round++) {
    const before = await Promise.all(clients.map(fingerprint));
    for (const c of clients) await c.engine.runCycle();
    for (const c of clients) await c.engine.runCycle();
    const after = await Promise.all(clients.map(fingerprint));
    if (before.every((b, i) => b === after[i]) && (await Promise.all(clients.map(isQuiet))).every(Boolean)) return;
  }
  throw new Error(`clients did not settle within ${maxRounds} rounds`);
}

async function fingerprint(c: SimClient): Promise<string> {
  const entries = [...c.adapter.snapshot().entries()].sort(([a], [b]) => (a < b ? -1 : 1));
  return `${await c.state.getCursor()}|${entries.map(([p, d]) => `${p}:${Buffer.from(d).toString('base64')}`).join(',')}`;
}

async function isQuiet(c: SimClient): Promise<boolean> {
  return (await c.state.dirtyEntries()).length === 0 && (await c.state.allPending()).length === 0;
}
