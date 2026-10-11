// Error handling that must not turn a temporary failure into a permanent
// one, drop a change, or repeat a refused one (code quality review, 2026-10-07).
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '../../src/api/client';
import { ErrorCode, NetworkError } from '../../src/api/errors';
import type { ChangesPage, CommitInput, CommitReply, HeadsPage, RemoteVersion } from '../../src/api/types';
import { encryptMeta, fileIdFor } from '../../src/crypto/objects';
import { generateUserKeys } from '../../src/crypto/userkeys';
import { buildKeyring, epochKeys, MissingEpochKeyError } from '../../src/crypto/vaultkeys';
import { fileHistory } from '../../src/services/history';
import { listRemoteVaults } from '../../src/services/vaults';
import { LocalState } from '../../src/state/store';
import { DEFAULT_MAX_FILE_BYTES, type SyncContext } from '../../src/sync/context';
import { SyncEngine } from '../../src/sync/engine';
import type { EngineEvent } from '../../src/sync/events';
import { PushMemory, pushRound } from '../../src/sync/push';
import { toHex } from '../../src/util/bytes';
import { ManualClock } from '../../src/util/clock';
import { errorMessage } from '../../src/util/errors';
import { seededRandom } from '../../src/util/random';
import { IgnoreRules } from '../../src/vault/ignore';
import { MemoryAdapter } from '../../src/vault/memory';

const VAULT = '0123456789abcdef0123456789abcdef';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('listRemoteVaults', () => {
  const session = { serverUrl: 'https://x', username: 'u', userId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', deviceId: 'd', deviceName: 'D', token: 't' };
  const vault = { vaultId: VAULT, encName: new Uint8Array(10), seq: 0, createdAtMs: 1, ownerId: session.userId, currentEpoch: 1 };

  it('lets a network failure through instead of calling the vault unreadable', async () => {
    const api = {
      listVaults: async () => [vault],
      vaultKeys: async () => {
        throw new NetworkError('offline');
      },
    } as unknown as ApiClient;
    await expect(listRemoteVaults(api, session, generateUserKeys(seededRandom(1)))).rejects.toBeInstanceOf(NetworkError);
  });

  it('still calls a vault whose sealed keys do not open unreadable', async () => {
    const api = {
      listVaults: async () => [vault],
      vaultKeys: async () => [{ epoch: 0, sealedKey: seededRandom(2).bytes(200) }],
    } as unknown as ApiClient;
    expect(await listRemoteVaults(api, session, generateUserKeys(seededRandom(1)))).toEqual([expect.objectContaining({ vaultId: VAULT, name: null })]);
  });

  it('calls a vault without a naming key for this account unreadable', async () => {
    const api = { listVaults: async () => [vault], vaultKeys: async () => [] } as unknown as ApiClient;
    expect(await listRemoteVaults(api, session, generateUserKeys(seededRandom(1)))).toEqual([expect.objectContaining({ name: null })]);
  });
});

describe('fileHistory', () => {
  it('says a version needs a key this device does not have yet, but marks a damaged one unreadable', async () => {
    const r = seededRandom(5);
    const ring = await buildKeyring(VAULT, r.bytes(32), new Map([[1, r.bytes(32)]]), 1);
    const fileId = await fileIdFor(ring.namingKey, 'n.md');
    const version = (epoch: number, encMeta: Uint8Array): RemoteVersion => ({
      fileId, versionId: r.bytes(16), baseVersionId: new Uint8Array(0), epoch, chunkIds: [], size: 0, deleted: false, deviceId: 'd', createdAtMs: 1, seq: 1, encMeta,
    });
    const damaged = version(1, r.bytes(80));
    const api = (versions: RemoteVersion[]) => ({ history: async () => versions }) as unknown as ApiClient;
    expect((await fileHistory(api([damaged]), ring, 'n.md'))[0]!.meta).toBeNull();
    await expect(fileHistory(api([version(2, r.bytes(80))]), ring, 'n.md')).rejects.toBeInstanceOf(MissingEpochKeyError);
    const meta = { path: 'n.md', mtimeMs: 1, size: 0, contentHash: new Uint8Array(0), renamedFrom: '', deviceName: 'd' };
    const good = version(1, new Uint8Array(0));
    good.encMeta = await encryptMeta(r, VAULT, epochKeys(ring, 1), fileId, good.versionId, meta);
    expect((await fileHistory(api([good]), ring, 'n.md'))[0]!.meta?.path).toBe('n.md');
  });
});

describe('the engine', () => {
  it('reconciles on the next cycle when recording a local change failed', async () => {
    const clock = new ManualClock(0);
    let heads = 0;
    const api = {
      baseUrl: 'http://localhost',
      vaultKeys: async () => [],
      changes: async (_v: string, since: number): Promise<ChangesPage> => ({ versions: [], vaultSeq: since, more: false }),
      history: async () => [], // the engine looks up the vault's .obsyncignore before a first pull
      heads: async (): Promise<HeadsPage> => {
        heads++;
        return { heads: [], more: false };
      },
      chunksExist: async (_v: string, ids: Uint8Array[]) => ids.map(() => true),
      putChunk: async () => undefined,
      commit: async (_v: string, commits: CommitInput[]): Promise<CommitReply> => ({
        results: commits.map((c) => ({ fileId: c.fileId, ok: true, seq: 1, headVersionId: c.versionId })), vaultSeq: 1,
      }),
    } as unknown as ApiClient;
    const r = seededRandom(1);
    const ring = await buildKeyring(VAULT, r.bytes(32), new Map([[1, r.bytes(32)]]), 1);
    const state = await LocalState.open(new IDBFactory(), 'engine-mark-fails');
    const adapter = new MemoryAdapter(false, clock);
    const engine = new SyncEngine({ configDir: '.obsidian', api, state, adapter, ring, deviceName: 'd', clock, random: r, webSocket: null, autoRun: false });
    await engine.start();
    await engine.runCycle(); // the reconcile at start
    const before = heads;
    vi.spyOn(state, 'markDirty').mockRejectedValueOnce(new Error('IndexedDB is closing'));
    await adapter.write('n.md', new TextEncoder().encode('edit\n'));
    await engine.whenIdle();
    await engine.runCycle();
    expect(heads).toBe(before + 1);
    expect(await state.getFile(toHex(await fileIdFor(ring.namingKey, 'n.md')))).toMatchObject({ path: 'n.md', deleted: false });
    await engine.stop();
  });
});

describe('a refused deletion', () => {
  it('is not sent again until the file comes back', async () => {
    const r = seededRandom(9);
    const ring = await buildKeyring(VAULT, r.bytes(32), new Map([[1, r.bytes(32)]]), 1);
    const state = await LocalState.open(new IDBFactory(), 'refused-deletion');
    const clock = new ManualClock();
    const adapter = new MemoryAdapter(false, clock);
    const fileId = toHex(await fileIdFor(ring.namingKey, 'n.md'));
    await state.recordSynced({ fileId, path: 'n.md', versionId: toHex(r.bytes(16)), deleted: false, contentHash: 'aa', size: 2, localMtime: 1, hasBase: false, seq: 1 }, null);
    const sent: CommitInput[][] = [];
    const api = {
      chunksExist: async (_v: string, ids: Uint8Array[]) => ids.map(() => true),
      putChunk: async () => undefined,
      commit: async (_v: string, commits: CommitInput[]): Promise<CommitReply> => {
        sent.push(commits);
        return {
          results: commits.map((c) => (c.deleted
            ? { fileId: c.fileId, ok: false, seq: 0, headVersionId: new Uint8Array(0), error: { code: ErrorCode.INVALID, message: 'version id reused' } }
            : { fileId: c.fileId, ok: true, seq: 2, headVersionId: c.versionId })),
          vaultSeq: 2,
        } as CommitReply;
      },
    } as unknown as ApiClient;
    const events: EngineEvent[] = [];
    const ctx: SyncContext = {
      api, state, adapter, ring, deviceName: 'd', clock, random: r, ignore: new IgnoreRules(), maxFileBytes: DEFAULT_MAX_FILE_BYTES, emit: (e) => events.push(e),
    };
    const mem = new PushMemory();
    await state.markDirty('n.md'); // the file is gone: a deletion
    await pushRound(ctx, mem);
    expect(sent).toHaveLength(1);
    expect(events.filter((e) => e.type === 'notice' && e.code === 'COMMIT_REJECTED')).toHaveLength(1);

    await state.markDirty('n.md'); // reconcile finds it gone again
    await pushRound(ctx, mem);
    expect(sent).toHaveLength(1);
    expect(await state.dirtyEntries()).toEqual([]);

    await adapter.write('n.md', new TextEncoder().encode('back\n'));
    await state.markDirty('n.md');
    await pushRound(ctx, mem);
    expect(sent).toHaveLength(2);
    expect(sent[1]![0]!.deleted).toBe(false);
  });
});

describe('errorMessage', () => {
  it('reads an Error, and prints anything else', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom');
    expect(errorMessage('plain')).toBe('plain');
    expect(errorMessage(undefined)).toBe('undefined');
    expect(errorMessage({ message: 'not an Error' })).toBe('[object Object]');
  });
});
