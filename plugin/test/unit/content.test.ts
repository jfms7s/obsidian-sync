import { describe, expect, it } from 'vitest';
import type { ApiClient } from '../../src/api/client';
import { NetworkError, TruncatedBodyError } from '../../src/api/errors';
import { CHUNK_SIZE } from '../../src/api/limits';
import type { RemoteVersion } from '../../src/api/types';
import { encryptChunk } from '../../src/crypto/objects';
import { CryptoError } from '../../src/crypto/primitives';
import { buildKeyring } from '../../src/crypto/vaultkeys';
import { toHex, utf8 } from '../../src/util/bytes';
import { seededRandom } from '../../src/util/random';
import { decodeText, downloadContent, isTextPath, prepareContent, splitChunks } from '../../src/sync/content';

const VAULT = '0123456789abcdef0123456789abcdef';

describe('content', () => {
  it('splits at 4 MiB and gives an empty file no chunks', () => {
    expect(splitChunks(new Uint8Array(0))).toEqual([]);
    expect(splitChunks(new Uint8Array(CHUNK_SIZE)).map((c) => c.length)).toEqual([CHUNK_SIZE]);
    expect(splitChunks(new Uint8Array(CHUNK_SIZE + 1)).map((c) => c.length)).toEqual([CHUNK_SIZE, 1]);
  });

  it('treats known text extensions with valid UTF-8 as text', () => {
    expect(isTextPath('a/b.MD')).toBe(true);
    expect(isTextPath('x.canvas')).toBe(true);
    expect(isTextPath('x.png')).toBe(false);
    expect(decodeText('a.md', new Uint8Array([0x68, 0x69]))).toBe('hi');
    expect(decodeText('a.md', new Uint8Array([0xff]))).toBeNull();
    expect(decodeText('a.png', new Uint8Array([0x68]))).toBeNull();
  });

  it('downloads, decrypts and verifies a multi-chunk version, retrying a cut-off download', async () => {
    const r = seededRandom(3);
    const ring = await buildKeyring(VAULT, r.bytes(32), new Map([[1, r.bytes(32)]]), 1);
    const keys = ring.epochs.get(1)!;
    const data = r.bytes(CHUNK_SIZE + 10);
    const prep = await prepareContent(keys, data);
    const blobs = new Map<string, Uint8Array>();
    for (let i = 0; i < prep.chunks.length; i++) blobs.set(toHex(prep.chunkIds[i]!), await encryptChunk(r, VAULT, keys, prep.chunkIds[i]!, prep.chunks[i]!));
    let failures = 1;
    const api = {
      getChunk: async (_v: string, id: Uint8Array) => {
        if (failures-- > 0) throw new TruncatedBodyError('cut off');
        return blobs.get(toHex(id))!;
      },
    } as unknown as ApiClient;
    const v: RemoteVersion = {
      fileId: new Uint8Array(32), versionId: new Uint8Array(16), baseVersionId: new Uint8Array(0), epoch: 1, encMeta: new Uint8Array(1),
      chunkIds: prep.chunkIds, size: data.length, deleted: false, deviceId: 'd', createdAtMs: 0, seq: 1,
    };
    expect(await downloadContent(api, ring, v, prep.contentHash)).toEqual(data);
    await expect(downloadContent(api, ring, v, new Uint8Array(32))).rejects.toBeInstanceOf(CryptoError);
    await expect(downloadContent(api, ring, { ...v, chunkIds: [...prep.chunkIds].reverse() }, prep.contentHash)).rejects.toBeInstanceOf(CryptoError);
  });
});

  it('keeps a byte-order mark when decoding text', () => {
    const bom = new Uint8Array([0xef, 0xbb, 0xbf, 0x68, 0x69]);
    expect(decodeText('a.md', bom)).toBe('\uFEFFhi');
    expect(utf8(decodeText('a.md', bom)!)).toEqual(bom);
  });

  it('refuses a chunk list that cannot make up the size, before fetching what it does not need', async () => {
    const r = seededRandom(4);
    const ring = await buildKeyring(VAULT, r.bytes(32), new Map([[1, r.bytes(32)]]), 1);
    const keys = ring.epochs.get(1)!;
    const small = await prepareContent(keys, r.bytes(10));
    const id = small.chunkIds[0]!;
    const sealed = await encryptChunk(r, VAULT, keys, id, small.chunks[0]!);
    let fetches = 0;
    const api = { getChunk: async () => { fetches++; return sealed; } } as unknown as ApiClient;
    const v = (chunkIds: Uint8Array[], size: number): RemoteVersion => ({
      fileId: new Uint8Array(32), versionId: new Uint8Array(16), baseVersionId: new Uint8Array(0), epoch: 1, encMeta: new Uint8Array(1),
      chunkIds, size, deleted: false, deviceId: 'd', createdAtMs: 0, seq: 1,
    });
    // A repeated small chunk posing as a two-chunk file: the first, not the last, is short.
    await expect(downloadContent(api, ring, v([id, id], CHUNK_SIZE + 10), small.contentHash)).rejects.toBeInstanceOf(CryptoError);
    expect(fetches).toBe(1);
    fetches = 0;
    await expect(downloadContent(api, ring, v([id, id, id], 30), small.contentHash)).rejects.toBeInstanceOf(CryptoError); // 3 chunks for 30 bytes
    await expect(downloadContent(api, ring, v([id], 0), small.contentHash)).rejects.toBeInstanceOf(CryptoError); // an empty file has none
    expect(fetches).toBe(0);
    await expect(downloadContent(api, ring, v([id], 5), small.contentHash)).rejects.toBeInstanceOf(CryptoError); // longer than its size
  });

  it('retries a cut-off body, but not a request that got no answer', async () => {
    const r = seededRandom(5);
    const ring = await buildKeyring(VAULT, r.bytes(32), new Map([[1, r.bytes(32)]]), 1);
    let calls = 0;
    const api = { getChunk: async () => { calls++; throw new NetworkError('fetch failed: offline'); } } as unknown as ApiClient;
    const prep = await prepareContent(ring.epochs.get(1)!, r.bytes(3));
    const v: RemoteVersion = {
      fileId: new Uint8Array(32), versionId: new Uint8Array(16), baseVersionId: new Uint8Array(0), epoch: 1, encMeta: new Uint8Array(1),
      chunkIds: prep.chunkIds, size: 3, deleted: false, deviceId: 'd', createdAtMs: 0, seq: 1,
    };
    await expect(downloadContent(api, ring, v, prep.contentHash)).rejects.toBeInstanceOf(NetworkError);
    expect(calls).toBe(1);
  });
