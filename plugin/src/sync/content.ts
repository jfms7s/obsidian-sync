// File content: text detection, chunking, hashing, and download/verify.
import type { ApiClient } from '../api/client';
import { ApiError, ErrorCode, isVaultNotFound, TruncatedBodyError } from '../api/errors';
import { CHUNK_SIZE } from '../api/limits';
import type { RemoteVersion } from '../api/types';
import { chunkIdFor, decryptChunk } from '../crypto/objects';
import { CryptoError, sha256 } from '../crypto/primitives';
import { epochKeys, type EpochKeys, type VaultKeyring } from '../crypto/vaultkeys';
import { equalBytes, fromUtf8Strict, toHex } from '../util/bytes';
import { extension } from '../util/path';
import { FileSyncError } from './failures';

/** Merged as text (spec §5.5); everything else is binary and conflicts as a whole. */
export const TEXT_EXTENSIONS: ReadonlySet<string> = new Set([
  'md', 'markdown', 'txt', 'canvas', 'base', 'json', 'css', 'js', 'mjs', 'ts', 'html', 'htm', 'xml', 'svg',
  'csv', 'tsv', 'yaml', 'yml', 'toml', 'ini', 'tex', 'bib', 'org', 'rst', 'adoc', 'log',
]);

export function isTextPath(path: string): boolean {
  return TEXT_EXTENSIONS.has(extension(path));
}

/** The content as text if path is a text type and the bytes are valid UTF-8, else null. */
export function decodeText(path: string, data: Uint8Array): string | null {
  return isTextPath(path) ? fromUtf8Strict(data) : null;
}

export function splitChunks(data: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let off = 0; off < data.length; off += CHUNK_SIZE) out.push(data.subarray(off, Math.min(data.length, off + CHUNK_SIZE)));
  return out;
}

export interface PreparedContent {
  chunks: Uint8Array[];
  chunkIds: Uint8Array[];
  contentHash: Uint8Array;
  size: number;
}

export async function prepareContent(keys: EpochKeys, data: Uint8Array): Promise<PreparedContent> {
  const chunks = splitChunks(data);
  const chunkIds: Uint8Array[] = [];
  for (const c of chunks) chunkIds.push(await chunkIdFor(keys, c));
  return { chunks, chunkIds, contentHash: await sha256(data), size: data.length };
}

export async function hashHex(data: Uint8Array): Promise<string> {
  return toHex(await sha256(data));
}

async function fetchChunk(api: ApiClient, vaultId: string, chunkId: Uint8Array): Promise<Uint8Array> {
  // A download cut off mid-stream (the server aborts the connection) is
  // retried at once a couple of times before the cycle gives up. A request
  // that got no answer at all (offline) is not: retrying at once would fail too.
  for (let attempt = 0; ; attempt++) {
    try {
      return await api.getChunk(vaultId, chunkId);
    } catch (err) {
      // The server lost this chunk: the version cannot be read, but the
      // rest of the vault can (failures.ts retries it later). A lost vault
      // fails the cycle instead.
      if (err instanceof ApiError && err.code === ErrorCode.NOT_FOUND && !isVaultNotFound(err)) {
        throw new FileSyncError('CONTENT_MISSING', 'the server is missing part of this version');
      }
      if (!(err instanceof TruncatedBodyError) || attempt >= 2) throw err;
    }
  }
}

/**
 * Downloads, decrypts and reassembles a version's content, then checks it
 * against the content hash and size from its metadata. The chunk list must
 * have the shape splitChunks gives that size (ceil(size / CHUNK_SIZE)
 * chunks, all but the last exactly CHUNK_SIZE), checked before and while
 * downloading, so a hostile list (one chunk id repeated many times) fails
 * early instead of being downloaded and assembled.
 */
export async function downloadContent(api: ApiClient, ring: VaultKeyring, v: RemoteVersion, contentHash: Uint8Array): Promise<Uint8Array> {
  const keys = epochKeys(ring, v.epoch);
  if (!Number.isSafeInteger(v.size) || v.size < 0) throw new CryptoError(`version size ${v.size} is not valid`);
  const want = Math.ceil(v.size / CHUNK_SIZE);
  if (v.chunkIds.length !== want) throw new CryptoError(`a ${v.size}-byte version has ${want} chunks, not ${v.chunkIds.length}`);
  const out = new Uint8Array(v.size);
  let off = 0;
  for (let i = 0; i < want; i++) {
    const id = v.chunkIds[i]!;
    const pt = await decryptChunk(ring.vaultId, keys, id, await fetchChunk(api, ring.vaultId, id));
    const expected = i < want - 1 ? CHUNK_SIZE : v.size - off;
    if (pt.length !== expected) throw new CryptoError(`chunk ${i} has ${pt.length} bytes, not ${expected}`);
    out.set(pt, off);
    off += pt.length;
  }
  if (!equalBytes(await sha256(out), contentHash)) throw new CryptoError('content does not match its hash');
  return out;
}
