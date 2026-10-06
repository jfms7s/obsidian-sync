// Logged-in, unlocked devices on a shared vault, without an engine: tests
// call pull, pushRound and reconcile on dev.ctx directly.
import { IDBFactory } from 'fake-indexeddb';
import type { ApiClient } from '../../src/api/client';
import { encryptChunk, encryptMeta, fileIdFor, type FileMeta } from '../../src/crypto/objects';
import { epochKeys, type VaultKeyring } from '../../src/crypto/vaultkeys';
import { apiFor, login, setupKeys, unlockWithPassphraseService } from '../../src/services/account';
import { chooseVault, createVault, keyringFromStored } from '../../src/services/vaults';
import { LocalState, type Session } from '../../src/state/store';
import { prepareContent } from '../../src/sync/content';
import { DEFAULT_MAX_FILE_BYTES, type SyncContext } from '../../src/sync/context';
import type { EngineEvent } from '../../src/sync/events';
import { pull } from '../../src/sync/pull';
import { PushMemory, pushRound } from '../../src/sync/push';
import { equalBytes, toHex } from '../../src/util/bytes';
import { ManualClock, type Clock } from '../../src/util/clock';
import { seededRandom, type Random } from '../../src/util/random';
import { IgnoreRules } from '../../src/vault/ignore';
import { MemoryAdapter } from '../../src/vault/memory';
import { Net } from './net';
import type { TestServer } from './server';

export const TEST_ARGON2 = { memoryKib: 8192, iterations: 1, parallelism: 1 };
export const PASSPHRASE = 'test encryption passphrase';

export interface User {
  username: string;
  password: string;
}

export interface Device {
  name: string;
  api: ApiClient;
  state: LocalState;
  adapter: MemoryAdapter;
  net: Net;
  ring: VaultKeyring;
  session: Session;
  vaultId: string;
  events: EngineEvent[];
  ctx: SyncContext;
  clock: Clock;
  random: Random;
}

export interface DeviceOptions {
  name: string;
  /** Create a new vault (first device) or join an existing one by id. */
  vault: 'create' | string;
  clock?: Clock;
  random?: Random;
  caseInsensitive?: boolean;
  ignoreGlobs?: string[];
  maxFileBytes?: number;
}

let counter = 0;

export async function newUser(srv: TestServer): Promise<User> {
  const user = { username: `user${++counter}x${process.pid}`, password: 'password123' };
  await srv.createUser(user.username, user.password);
  return user;
}

export async function newDevice(srv: TestServer, user: User, o: DeviceOptions): Promise<Device> {
  const random = o.random ?? seededRandom(++counter * 7919);
  const clock = o.clock ?? new ManualClock();
  const net = new Net();
  const state = await LocalState.open(new IDBFactory(), `obsync-${o.name}`);
  const deps = { fetch: net.fetch, clock };
  const session = await login(state, srv.url, user.username, user.password, o.name, 'node-test', deps);
  const api = apiFor(session, deps);
  const keys = (await api.getKeyBundle())
    ? await unlockWithPassphraseService(state, api, session, PASSPHRASE)
    : (await setupKeys(state, api, session, PASSPHRASE, random, TEST_ARGON2)).keys;
  const stored = o.vault === 'create'
    ? await createVault(state, api, session, keys, `vault of ${user.username}`, random)
    : await chooseVault(state, api, session, keys, o.vault);
  const ring = await keyringFromStored(stored);
  const adapter = new MemoryAdapter(o.caseInsensitive ?? false, clock);
  const events: EngineEvent[] = [];
  const ctx: SyncContext = {
    api, state, adapter, ring, deviceName: o.name, clock, random,
    ignore: new IgnoreRules(o.ignoreGlobs ?? [], { caseInsensitive: adapter.caseInsensitive, configDir: '.obsidian' }), maxFileBytes: o.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES, emit: (e) => events.push(e),
  };
  return { name: o.name, api, state, adapter, net, ring, session, vaultId: stored.vaultId, events, ctx, clock, random };
}

/** Marks every adapter event dirty, as the engine does (for tests that drive push without an engine). */
export function trackChanges(dev: Device): () => Promise<void> {
  let chain: Promise<unknown> = Promise.resolve();
  dev.adapter.watch((ev) => {
    chain = chain.then(async () => {
      if (ev.type === 'rename') {
        await dev.state.markDirty(ev.oldPath);
        await dev.state.markDirty(ev.path, ev.oldPath);
      } else {
        await dev.state.markDirty(ev.path);
      }
    });
  });
  return async () => {
    await chain;
  };
}

/**
 * Commits content (null = delete) for path straight to the server on top of
 * its current head, as some other device would. metaOverride replaces
 * FileMeta fields (to send renamed_from, or to forge an inconsistent one).
 * Returns the new version id.
 */
export async function remoteCommit(
  dev: Device, path: string, content: Uint8Array | null, deviceName = 'Remote', metaOverride: Partial<FileMeta> = {},
): Promise<Uint8Array> {
  const { api, ring, random } = dev;
  const keys = epochKeys(ring, ring.currentEpoch);
  const fileId = await fileIdFor(ring.namingKey, path);
  const heads = (await api.heads(ring.vaultId, null)).heads;
  const base = heads.find((h) => equalBytes(h.fileId, fileId))?.versionId ?? new Uint8Array(0);
  const versionId = random.bytes(16);
  const prep = content ? await prepareContent(keys, content) : null;
  if (prep) {
    for (let i = 0; i < prep.chunks.length; i++) {
      await api.putChunk(ring.vaultId, prep.chunkIds[i]!, await encryptChunk(random, ring.vaultId, keys, prep.chunkIds[i]!, prep.chunks[i]!));
    }
  }
  const meta = { path, mtimeMs: 1, size: prep?.size ?? 0, contentHash: prep?.contentHash ?? new Uint8Array(0), renamedFrom: '', deviceName, ...metaOverride };
  const reply = await api.commit(ring.vaultId, [{
    fileId, versionId, baseVersionId: base, epoch: keys.epoch, encMeta: await encryptMeta(random, ring.vaultId, keys, fileId, versionId, meta),
    chunkIds: prep?.chunkIds ?? [], size: prep?.size ?? 0, deleted: content === null,
  }]);
  if (!reply.results[0]!.ok) throw new Error(`remote commit failed: ${reply.results[0]!.error?.message}`);
  return versionId;
}

/** Which of two names that differ only in letter case keeps the path on a case-insensitive device: the one with the lower file id. */
export async function nameKeepingCollision(dev: Device, x: string, y: string): Promise<string> {
  const idx = toHex(await fileIdFor(dev.ring.namingKey, x));
  const idy = toHex(await fileIdFor(dev.ring.namingKey, y));
  return idx < idy ? x : y;
}

export function text(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

export function files(adapter: MemoryAdapter): Record<string, string> {
  return Object.fromEntries([...adapter.snapshot().entries()].map(([p, d]) => [p, new TextDecoder().decode(d)]));
}

/**
 * Device A's commit of a.md lands but its response is lost (a pending
 * commit P stays on A), and device B then commits twice on top of it
 * (P → X → Y). A has not pulled since; its a.md still holds P's text.
 */
export async function landedPendingOvertakenTwice(srv: TestServer): Promise<{ a: Device; b: Device; p: string; y: string }> {
  const user = await newUser(srv);
  const a = await newDevice(srv, user, { name: 'A', vault: 'create' });
  const b = await newDevice(srv, user, { name: 'B', vault: a.vaultId });
  await a.adapter.write('a.md', text('base\n'));
  await a.state.markDirty('a.md');
  await pushRound(a.ctx, new PushMemory());
  await pull(b.ctx);
  await a.adapter.write('a.md', text('base\nmine\n'));
  await a.state.markDirty('a.md');
  a.net.loseNextResponse('POST', '/commit');
  await pushRound(a.ctx, new PushMemory()).catch(() => undefined);
  const [pending] = await a.state.allPending();
  if (!pending) throw new Error('expected a pending commit');
  await pull(b.ctx);
  await b.adapter.write('a.md', text('base\nmine\ntheirs\n'));
  await b.state.markDirty('a.md');
  await pushRound(b.ctx, new PushMemory());
  await b.adapter.write('a.md', text('base\nmine\ntheirs\nmore\n'));
  await b.state.markDirty('a.md');
  await pushRound(b.ctx, new PushMemory());
  const y = (await b.state.filesByPath('a.md'))[0]!.versionId!;
  return { a, b, p: pending.versionId, y };
}
