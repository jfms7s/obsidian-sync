// Known-answer tests for file ids, chunks, metadata and vault names: vectors from server/cmd/vectorgen (Go).
import { describe, expect, it } from 'vitest';
import { chunkAad, metaAad, vaultNameAad, vaultNameSigMessage } from '../../src/crypto/labels';
import { pad, paddedSize, unpad } from '../../src/crypto/padding';
import {
  chunkIdFor, decodeFileMeta, decryptChunk, decryptMeta, decryptVaultName, encodeFileMeta, encryptChunkWith, encryptMetaWith,
  encryptVaultNameWith, fileIdFor,
} from '../../src/crypto/objects';
import { sha256 } from '../../src/crypto/primitives';
import { buildKeyring, deriveEpochKeys } from '../../src/crypto/vaultkeys';
import { fromHex as h, toHex, utf8 } from '../../src/util/bytes';
import { normalizePath } from '../../src/util/path';
import { loadVectors } from '../helpers/vectors';

describe('file id vectors', () => {
  const v = loadVectors<{ naming_key: string; cases: Array<{ input: string; path: string; file_id: string }> }>('file-ids.json');
  it.each(v.cases)('$path', async (c) => {
    expect(normalizePath(c.input)).toBe(c.path);
    expect(toHex(await fileIdFor(h(v.naming_key), c.input))).toBe(c.file_id);
  });
});

describe('chunk vectors', () => {
  const v = loadVectors<{ vault_id: string; epoch: number; epoch_key: string; cases: Array<{ plaintext: string; chunk_id: string; nonce: string; aad: string; sealed: string }> }>('chunks.json');
  it.each(v.cases)('chunk $chunk_id', async (c) => {
    const keys = await deriveEpochKeys(v.vault_id, v.epoch, h(v.epoch_key));
    const id = await chunkIdFor(keys, h(c.plaintext));
    expect(toHex(id)).toBe(c.chunk_id);
    expect(toHex(chunkAad(v.vault_id, v.epoch, id))).toBe(c.aad);
    expect(toHex(await encryptChunkWith(h(c.nonce), v.vault_id, keys, id, h(c.plaintext)))).toBe(c.sealed);
    expect(toHex(await decryptChunk(v.vault_id, keys, id, h(c.sealed)))).toBe(c.plaintext);
  });
});

describe('file metadata vectors', () => {
  type M = { path: string; mtime_ms: number; size: number; content_hash: string; renamed_from: string; device_name: string };
  const v = loadVectors<{ vault_id: string; epoch: number; epoch_key: string; naming_key: string; cases: Array<{ content: string | null; meta: M; file_id: string; version_id: string; plaintext: string; padded: string; nonce: string; aad: string; enc_meta: string }> }>('meta.json');
  it.each(v.cases)('$meta.path', async (c) => {
    if (c.content !== null) expect(toHex(await sha256(utf8(c.content)))).toBe(c.meta.content_hash);
    const meta = {
      path: c.meta.path, mtimeMs: c.meta.mtime_ms, size: c.meta.size, contentHash: h(c.meta.content_hash),
      renamedFrom: c.meta.renamed_from, deviceName: c.meta.device_name,
    };
    expect(toHex(encodeFileMeta(meta))).toBe(c.plaintext);
    expect(decodeFileMeta(h(c.plaintext))).toEqual(meta);
    expect(toHex(pad(h(c.plaintext)))).toBe(c.padded);
    expect(toHex(unpad(h(c.padded)))).toBe(c.plaintext);
    expect(toHex(await fileIdFor(h(v.naming_key), c.meta.path))).toBe(c.file_id);
    expect(toHex(metaAad(v.vault_id, v.epoch, h(c.file_id), h(c.version_id)))).toBe(c.aad);
    const keys = await deriveEpochKeys(v.vault_id, v.epoch, h(v.epoch_key));
    expect(toHex(await encryptMetaWith(h(c.nonce), v.vault_id, keys, h(c.file_id), h(c.version_id), meta))).toBe(c.enc_meta);
    const ring = await buildKeyring(v.vault_id, h(v.naming_key), new Map([[v.epoch, h(v.epoch_key)]]), v.epoch);
    expect(await decryptMeta(ring, v.epoch, h(c.file_id), h(c.version_id), h(c.enc_meta))).toEqual(meta);
  });
});

describe('vault name vectors', () => {
  const v = loadVectors<{ vault_id: string; epoch: number; epoch_key: string; signer_seed: string; signer_pub: string; cases: Array<{ input: string; name: string; nonce: string; aad: string; sig_message: string; enc_name: string }> }>('vault-names.json');
  it.each(v.cases)('$name', async (c) => {
    const keys = await deriveEpochKeys(v.vault_id, v.epoch, h(v.epoch_key));
    expect(toHex(vaultNameAad(v.vault_id, v.epoch))).toBe(c.aad);
    const encName = h(c.enc_name);
    expect(toHex(vaultNameSigMessage(v.vault_id, v.epoch, encName.subarray(0, encName.length - 64)))).toBe(c.sig_message);
    expect(toHex(await encryptVaultNameWith(h(c.nonce), v.vault_id, keys, c.input, h(v.signer_seed)))).toBe(c.enc_name);
    const ring = await buildKeyring(v.vault_id, new Uint8Array(32), new Map([[v.epoch, h(v.epoch_key)]]), v.epoch);
    expect(await decryptVaultName(ring, encName, h(v.signer_pub))).toBe(c.name);
  });
});

describe('padding vectors', () => {
  const v = loadVectors<{ cases: Array<{ length: number; padded_length: number }> }>('padding.json');
  it.each(v.cases)('$length bytes pad to $padded_length', (c) => {
    expect(paddedSize(c.length)).toBe(c.padded_length);
    expect(pad(new Uint8Array(c.length)).length).toBe(c.padded_length);
  });
});
