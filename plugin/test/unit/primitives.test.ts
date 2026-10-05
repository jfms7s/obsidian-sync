// Published test vectors for the WebCrypto wrappers.
import { describe, expect, it } from 'vitest';
import { aesGcmOpen, aesGcmSeal, CryptoError, hkdfSha256, hmacSha256, sha256 } from '../../src/crypto/primitives';
import { fromHex, toHex, utf8 } from '../../src/util/bytes';

describe('WebCrypto wrappers', () => {
  it('SHA-256 of "abc" (FIPS 180-2)', async () => {
    expect(toHex(await sha256(utf8('abc')))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('HMAC-SHA256 (RFC 4231 test case 2)', async () => {
    expect(toHex(await hmacSha256(utf8('Jefe'), utf8('what do ya want for nothing?'))))
      .toBe('5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843');
  });

  it('HKDF-SHA256 (RFC 5869 test case 1)', async () => {
    const okm = await hkdfSha256(fromHex('0b'.repeat(22)), fromHex('000102030405060708090a0b0c'), fromHex('f0f1f2f3f4f5f6f7f8f9'), 42);
    expect(toHex(okm)).toBe('3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865');
  });

  it('HKDF with an empty salt equals HashLen zero bytes (RFC 5869 test case 3)', async () => {
    const okm = await hkdfSha256(fromHex('0b'.repeat(22)), new Uint8Array(0), new Uint8Array(0), 42);
    expect(toHex(okm)).toBe('8da4e775a563c18f715f802a063c5a31b8a11f5c5ee1879ec3454e5f3c738d2d9d201395faa4b61a96c8');
  });

  it('AES-256-GCM lays out nonce ‖ ciphertext ‖ tag and authenticates the AAD', async () => {
    const key = new Uint8Array(32).fill(7);
    const nonce = new Uint8Array(12).fill(9);
    const sealed = await aesGcmSeal(key, nonce, utf8('hello'), utf8('aad'));
    expect(sealed.length).toBe(12 + 5 + 16);
    expect(toHex(sealed.subarray(0, 12))).toBe(toHex(nonce));
    expect(new TextDecoder().decode(await aesGcmOpen(key, sealed, utf8('aad')))).toBe('hello');
    await expect(aesGcmOpen(key, sealed, utf8('other'))).rejects.toBeInstanceOf(CryptoError);
    await expect(aesGcmOpen(key, sealed.subarray(0, 20), utf8('aad'))).rejects.toBeInstanceOf(CryptoError);
    await expect(aesGcmSeal(new Uint8Array(16), nonce, utf8('x'), utf8(''))).rejects.toBeInstanceOf(RangeError);
  });
});
