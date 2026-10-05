// Length hiding for small plaintexts (file metadata, vault names): the
// ciphertext reveals only a size bucket, not the exact path or name length.
import { CryptoError } from './primitives';

export const MIN_PADDED = 128;

/** The padded size for a message of n bytes: max(128, the next power of two ≥ 4 + n). */
export function paddedSize(n: number): number {
  let p = MIN_PADDED;
  while (p < 4 + n) p *= 2;
  return p;
}

/** u32be(len(msg)) ‖ msg ‖ zero bytes, paddedSize(len(msg)) bytes in all. */
export function pad(msg: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(paddedSize(msg.length));
  new DataView(out.buffer).setUint32(0, msg.length, false);
  out.set(msg, 4);
  return out;
}

/** Reverses pad(), refusing a length that does not fit or padding that is not zero. */
export function unpad(padded: Uint8Array): Uint8Array {
  if (padded.length < 4) throw new CryptoError('padded plaintext too short');
  const n = new DataView(padded.buffer, padded.byteOffset, 4).getUint32(0, false);
  if (n > padded.length - 4 || padded.length !== paddedSize(n)) throw new CryptoError('bad padding length');
  for (let i = 4 + n; i < padded.length; i++) if (padded[i] !== 0) throw new CryptoError('bad padding');
  return padded.subarray(4, 4 + n);
}
