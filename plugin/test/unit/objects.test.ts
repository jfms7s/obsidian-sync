// Properties the vectors cannot show: tampering and wrong bindings fail.
import { ed25519 } from '@noble/curves/ed25519.js';
import { describe, expect, it } from 'vitest';
import {
  chunkIdFor, decryptChunk, decryptMeta, decryptVaultName, encryptChunk, encryptMeta, encryptVaultName, fileIdFor,
} from '../../src/crypto/objects';
import { CryptoError } from '../../src/crypto/primitives';
import { buildKeyring } from '../../src/crypto/vaultkeys';
import { seededRandom } from '../../src/util/random';

const VAULT = '0123456789abcdef0123456789abcdef';
const OTHER_VAULT = 'fedcba9876543210fedcba9876543210';

async function ring(vaultId = VAULT) {
  const r = seededRandom(9);
  return buildKeyring(vaultId, r.bytes(32), new Map([[1, r.bytes(32)]]), 1);
}

function flip(b: Uint8Array, i: number): Uint8Array {
  const c = b.slice();
  c[i] = c[i]! ^ 1;
  return c;
}

describe('object encryption', () => {
  it('rejects a tampered chunk, and one presented under another id or vault', async () => {
    const k = (await ring()).epochs.get(1)!;
    const pt = new TextEncoder().encode('secret chunk');
    const id = await chunkIdFor(k, pt);
    const sealed = await encryptChunk(seededRandom(1), VAULT, k, id, pt);
    await expect(decryptChunk(VAULT, k, id, flip(sealed, 20))).rejects.toBeInstanceOf(CryptoError);
    await expect(decryptChunk(OTHER_VAULT, k, id, sealed)).rejects.toBeInstanceOf(CryptoError);
    await expect(decryptChunk(VAULT, k, flip(id, 0), sealed)).rejects.toBeInstanceOf(CryptoError);
  });

  it('binds metadata to its file and version', async () => {
    const r = await ring();
    const k = r.epochs.get(1)!;
    const fileId = await fileIdFor(r.namingKey, 'a.md');
    const versionId = seededRandom(2).bytes(16);
    const meta = { path: 'a.md', mtimeMs: 1, size: 0, contentHash: new Uint8Array(32), renamedFrom: '', deviceName: 'd' };
    const enc = await encryptMeta(seededRandom(3), VAULT, k, fileId, versionId, meta);
    expect(await decryptMeta(r, 1, fileId, versionId, enc)).toEqual(meta);
    await expect(decryptMeta(r, 1, fileId, seededRandom(4).bytes(16), enc)).rejects.toBeInstanceOf(CryptoError);
    await expect(decryptMeta(r, 1, await fileIdFor(r.namingKey, 'b.md'), versionId, enc)).rejects.toBeInstanceOf(CryptoError);
  });

  it('refuses metadata whose path does not hash to its file id', async () => {
    const r = await ring();
    const k = r.epochs.get(1)!;
    const wrongFileId = await fileIdFor(r.namingKey, 'b.md');
    const versionId = seededRandom(2).bytes(16);
    const enc = await encryptMeta(seededRandom(3), VAULT, k, wrongFileId, versionId, { path: 'a.md', mtimeMs: 1, size: 0, contentHash: new Uint8Array(0), renamedFrom: '', deviceName: '' });
    await expect(decryptMeta(r, 1, wrongFileId, versionId, enc)).rejects.toThrow(/does not match the file id/);
  });

  it('round-trips vault names and rejects tampering, another vault or another signer', async () => {
    const r = await ring();
    const seed = seededRandom(11).bytes(32);
    const pub = ed25519.getPublicKey(seed);
    const enc = await encryptVaultName(seededRandom(5), VAULT, r.epochs.get(1)!, 'Work', seed);
    expect(await decryptVaultName(r, enc, pub)).toBe('Work');
    await expect(decryptVaultName(r, flip(enc, 10), pub)).rejects.toBeInstanceOf(CryptoError);
    await expect(decryptVaultName(await ring(OTHER_VAULT), enc, pub)).rejects.toBeInstanceOf(CryptoError);
    const forged = await encryptVaultName(seededRandom(5), VAULT, r.epochs.get(1)!, 'Work', seededRandom(12).bytes(32));
    await expect(decryptVaultName(r, forged, pub)).rejects.toThrow(/not signed by the expected key/);
  });

  it('hides path lengths up to the padding bucket', async () => {
    const r = await ring();
    const k = r.epochs.get(1)!;
    const sizes = await Promise.all(['a.md', 'a much longer path/with folders/note.md'].map(async (path) => {
      const fileId = await fileIdFor(r.namingKey, path);
      const meta = { path, mtimeMs: 1, size: 1, contentHash: new Uint8Array(32), renamedFrom: '', deviceName: 'Laptop' };
      return (await encryptMeta(seededRandom(3), VAULT, k, fileId, seededRandom(4).bytes(16), meta)).length;
    }));
    expect(sizes).toEqual([12 + 128 + 16, 12 + 128 + 16]);
  });
});
