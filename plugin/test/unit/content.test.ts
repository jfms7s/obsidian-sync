import { describe, expect, it } from 'vitest';
import type { ApiClient } from '../../src/api/client';
import { NetworkError } from '../../src/api/errors';
import { CHUNK_SIZE } from '../../src/api/limits';
import type { RemoteVersion } from '../../src/api/types';
import { encryptChunk } from '../../src/crypto/objects';
import { CryptoError } from '../../src/crypto/primitives';
import { buildKeyring } from '../../src/crypto/vaultkeys';
import { toHex } from '../../src/util/bytes';
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
        if (failures-- > 0) throw new NetworkError('cut off');
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
