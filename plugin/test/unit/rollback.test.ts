// A server restored from a backup answers Changes with vault_seq below this
// device's cursor. The engine must notice, stop trusting its synced
// versions, and compare everything again instead of skipping new commits.
import { IDBFactory } from 'fake-indexeddb';
import { expect, it } from 'vitest';
import type { ApiClient } from '../../src/api/client';
import type { ChangesPage, HeadsPage } from '../../src/api/types';
import { buildKeyring } from '../../src/crypto/vaultkeys';
import { LocalState } from '../../src/state/store';
import { SyncEngine } from '../../src/sync/engine';
import type { EngineEvent } from '../../src/sync/events';
import { ManualClock } from '../../src/util/clock';
import { seededRandom } from '../../src/util/random';
import { MemoryAdapter } from '../../src/vault/memory';

it('detects a server rollback and forgets synced versions', async () => {
  const state = await LocalState.open(new IDBFactory(), 'rb');
  await state.setCursorAndAnchor(10, null);
  await state.recordSynced({ fileId: 'aa', path: 'a.md', versionId: '01', deleted: false, contentHash: 'h', size: 1, localMtime: 1, hasBase: false, seq: 5 }, 'a');
  let changesCalls = 0;
  const api = {
    token: undefined,
    baseUrl: 'http://localhost',
    changes: async (): Promise<ChangesPage> => {
      changesCalls++;
      return { versions: [], vaultSeq: 3, more: false };
    },
    heads: async (): Promise<HeadsPage> => ({ heads: [], more: false }),
  } as unknown as ApiClient;
  const r = seededRandom(1);
  const ring = await buildKeyring('0123456789abcdef0123456789abcdef', r.bytes(32), new Map([[1, r.bytes(32)]]), 1);
  const events: EngineEvent[] = [];
  const engine = new SyncEngine({ api, state, adapter: new MemoryAdapter(), ring, deviceName: 'd', clock: new ManualClock(), random: r, autoRun: false, webSocket: null });
  engine.on((e) => events.push(e));
  await engine.start();
  await engine.runCycle();
  expect(events).toContainEqual(expect.objectContaining({ type: 'notice', code: 'SERVER_ROLLBACK' }));
  expect(await state.getFile('aa')).toMatchObject({ versionId: null, contentHash: null });
  await engine.runCycle(); // reconciles from cursor 0
  expect(await state.getCursor()).toBe(3);
  // a.md is gone locally and no longer counts as synced: nothing to delete on the server.
  expect(await state.dirtyEntries()).toEqual([]);
  expect(changesCalls).toBe(2);
});
