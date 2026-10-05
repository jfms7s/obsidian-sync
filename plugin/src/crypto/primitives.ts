// Thin wrappers over WebCrypto. Every key here is 32 raw bytes.
import { bs, concat } from '../util/bytes';

export const KEY_LEN = 32;
export const NONCE_LEN = 12;
export const TAG_LEN = 16;

/** Decryption or verification failed: wrong key, tampered data or wrong binding. */
export class CryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CryptoError';
  }
}

function checkKey(key: Uint8Array): void {
  if (key.length !== KEY_LEN) throw new RangeError(`key must be ${KEY_LEN} bytes, got ${key.length}`);
}

export async function sha256(data: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bs(data)));
}

export async function hmacSha256(key: Uint8Array, data: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  const k = await crypto.subtle.importKey('raw', bs(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, bs(data)));
}

/** HKDF-SHA256 (RFC 5869). An empty salt means HashLen zero bytes. */
export async function hkdfSha256(ikm: Uint8Array, salt: Uint8Array, info: Uint8Array, length = KEY_LEN): Promise<Uint8Array<ArrayBuffer>> {
  const k = await crypto.subtle.importKey('raw', bs(ikm), 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: bs(salt), info: bs(info) }, k, length * 8);
  return new Uint8Array(bits);
}

/** AES-256-GCM. Returns nonce ‖ ciphertext ‖ tag. */
export async function aesGcmSeal(key: Uint8Array, nonce: Uint8Array, plaintext: Uint8Array, aad: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  checkKey(key);
  if (nonce.length !== NONCE_LEN) throw new RangeError(`nonce must be ${NONCE_LEN} bytes`);
  const k = await crypto.subtle.importKey('raw', bs(key), 'AES-GCM', false, ['encrypt']);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: bs(nonce), additionalData: bs(aad), tagLength: TAG_LEN * 8 }, k, bs(plaintext));
  return concat(nonce, new Uint8Array(ct));
}

/** Opens nonce ‖ ciphertext ‖ tag. Throws CryptoError if it does not authenticate. */
export async function aesGcmOpen(key: Uint8Array, sealed: Uint8Array, aad: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  checkKey(key);
  if (sealed.length < NONCE_LEN + TAG_LEN) throw new CryptoError('ciphertext too short');
  const k = await crypto.subtle.importKey('raw', bs(key), 'AES-GCM', false, ['decrypt']);
  try {
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: bs(sealed.subarray(0, NONCE_LEN)), additionalData: bs(aad), tagLength: TAG_LEN * 8 },
      k,
      bs(sealed.subarray(NONCE_LEN)),
    );
    return new Uint8Array(pt);
  } catch {
    throw new CryptoError('decryption failed');
  }
}
