// Object encryption (spec §5.1, §5.2, §6.4): file ids, chunk ids, chunks,
// file metadata and vault names.
import { ed25519 } from '@noble/curves/ed25519.js';
import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import { FileMetaSchema } from '../gen/obsync/v1/obsync_pb';
import { concat, equalBytes, fromUtf8Strict, u32be, utf8 } from '../util/bytes';
import { normalizePath } from '../util/path';
import type { Random } from '../util/random';
import { chunkAad, metaAad, vaultNameAad, vaultNameSigMessage } from './labels';
import { pad, unpad } from './padding';
import { aesGcmOpen, aesGcmSeal, CryptoError, hmacSha256, NONCE_LEN } from './primitives';
import type { EpochKeys, VaultKeyring } from './vaultkeys';
import { epochKeys } from './vaultkeys';

/** file_id = HMAC-SHA256(naming_key, UTF-8(normalized path)). An invalid path rejects with InvalidPathError. */
export async function fileIdFor(namingKey: Uint8Array, path: string): Promise<Uint8Array> {
  return hmacSha256(namingKey, utf8(normalizePath(path)));
}

/** chunk_id = HMAC-SHA256(chunk_id_key[e], plaintext chunk). */
export function chunkIdFor(keys: EpochKeys, plaintext: Uint8Array): Promise<Uint8Array> {
  return hmacSha256(keys.chunkIdKey, plaintext);
}

export function encryptChunkWith(nonce: Uint8Array, vaultId: string, keys: EpochKeys, chunkId: Uint8Array, plaintext: Uint8Array): Promise<Uint8Array> {
  return aesGcmSeal(keys.contentKey, nonce, plaintext, chunkAad(vaultId, keys.epoch, chunkId));
}

export function encryptChunk(random: Random, vaultId: string, keys: EpochKeys, chunkId: Uint8Array, plaintext: Uint8Array): Promise<Uint8Array> {
  return encryptChunkWith(random.bytes(NONCE_LEN), vaultId, keys, chunkId, plaintext);
}

/** Decrypts a chunk and checks that its plaintext really has chunkId. */
export async function decryptChunk(vaultId: string, keys: EpochKeys, chunkId: Uint8Array, sealed: Uint8Array): Promise<Uint8Array> {
  const pt = await aesGcmOpen(keys.contentKey, sealed, chunkAad(vaultId, keys.epoch, chunkId));
  if (!equalBytes(await chunkIdFor(keys, pt), chunkId)) throw new CryptoError('chunk content does not match its id');
  return pt;
}

export interface FileMeta {
  path: string;
  mtimeMs: number;
  size: number;
  contentHash: Uint8Array; // empty for a deletion
  renamedFrom: string; // '' if not a rename
  deviceName: string;
}

export function encodeFileMeta(m: FileMeta): Uint8Array {
  return toBinary(FileMetaSchema, create(FileMetaSchema, {
    path: m.path,
    mtimeMs: BigInt(Math.trunc(m.mtimeMs)),
    size: BigInt(m.size),
    contentHash: m.contentHash,
    renamedFrom: m.renamedFrom,
    deviceName: m.deviceName,
  }));
}

export function decodeFileMeta(b: Uint8Array): FileMeta {
  const m = fromBinary(FileMetaSchema, b);
  return {
    path: m.path,
    mtimeMs: Number(m.mtimeMs),
    size: Number(m.size),
    contentHash: m.contentHash,
    renamedFrom: m.renamedFrom,
    deviceName: m.deviceName,
  };
}

/** enc_meta = AES-256-GCM(meta_key[e], pad(FileMeta), AAD); see padding.ts. */
export function encryptMetaWith(nonce: Uint8Array, vaultId: string, keys: EpochKeys, fileId: Uint8Array, versionId: Uint8Array, meta: FileMeta): Promise<Uint8Array> {
  return aesGcmSeal(keys.metaKey, nonce, pad(encodeFileMeta(meta)), metaAad(vaultId, keys.epoch, fileId, versionId));
}

export function encryptMeta(random: Random, vaultId: string, keys: EpochKeys, fileId: Uint8Array, versionId: Uint8Array, meta: FileMeta): Promise<Uint8Array> {
  return encryptMetaWith(random.bytes(NONCE_LEN), vaultId, keys, fileId, versionId, meta);
}

/**
 * Decrypts enc_meta and checks its binding: the path must be normalized and
 * hash to fileId under the naming key, so the server cannot move a version
 * to another file.
 */
export async function decryptMeta(ring: VaultKeyring, epoch: number, fileId: Uint8Array, versionId: Uint8Array, encMeta: Uint8Array): Promise<FileMeta> {
  const keys = epochKeys(ring, epoch);
  const pt = await aesGcmOpen(keys.metaKey, encMeta, metaAad(ring.vaultId, epoch, fileId, versionId));
  let meta: FileMeta;
  try {
    meta = decodeFileMeta(unpad(pt));
  } catch {
    throw new CryptoError('enc_meta is not a FileMeta');
  }
  if (normalizePath(meta.path) !== meta.path || !equalBytes(await fileIdFor(ring.namingKey, meta.path), fileId)) {
    throw new CryptoError('enc_meta path does not match the file id');
  }
  return meta;
}

export const MAX_VAULT_NAME_BYTES = 200;

/**
 * enc_name = core ‖ Ed25519(creator, "obsync/v1/vault-name-sig" ‖ vault_id ‖ u32be(e) ‖ core)
 * core     = u32be(e) ‖ AES-256-GCM(vault_name_key[e], pad(UTF-8(NFC(name))), AAD = label ‖ vault_id ‖ u32be(e)).
 */
export async function encryptVaultNameWith(nonce: Uint8Array, vaultId: string, keys: EpochKeys, name: string, signSeed: Uint8Array): Promise<Uint8Array> {
  const pt = utf8(name.normalize('NFC'));
  if (pt.length === 0 || pt.length > MAX_VAULT_NAME_BYTES) throw new RangeError(`vault names are 1 to ${MAX_VAULT_NAME_BYTES} bytes`);
  const core = concat(u32be(keys.epoch), await aesGcmSeal(keys.vaultNameKey, nonce, pad(pt), vaultNameAad(vaultId, keys.epoch)));
  return concat(core, ed25519.sign(vaultNameSigMessage(vaultId, keys.epoch, core), signSeed));
}

export function encryptVaultName(random: Random, vaultId: string, keys: EpochKeys, name: string, signSeed: Uint8Array): Promise<Uint8Array> {
  return encryptVaultNameWith(random.bytes(NONCE_LEN), vaultId, keys, name, signSeed);
}

/** Checks the creator's signature (signerPub), then decrypts. */
export async function decryptVaultName(ring: VaultKeyring, encName: Uint8Array, signerPub: Uint8Array): Promise<string> {
  if (encName.length < 4 + 64) throw new CryptoError('enc_name too short');
  const core = encName.subarray(0, encName.length - 64);
  const epoch = new DataView(core.buffer, core.byteOffset, 4).getUint32(0, false);
  if (!ed25519.verify(encName.subarray(encName.length - 64), vaultNameSigMessage(ring.vaultId, epoch, core), signerPub, { zip215: false })) {
    throw new CryptoError('vault name is not signed by the expected key');
  }
  const keys = epochKeys(ring, epoch);
  const pt = unpad(await aesGcmOpen(keys.vaultNameKey, core.subarray(4), vaultNameAad(ring.vaultId, epoch)));
  const name = fromUtf8Strict(pt);
  if (name === null) throw new CryptoError('vault name is not UTF-8');
  return name;
}
