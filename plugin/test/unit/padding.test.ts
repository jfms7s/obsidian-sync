import { expect, it } from 'vitest';
import { pad, unpad } from '../../src/crypto/padding';
import { CryptoError } from '../../src/crypto/primitives';

it('round-trips and refuses malformed padding', () => {
  const msg = new TextEncoder().encode('hello');
  const p = pad(msg);
  expect(p.length).toBe(128);
  expect(unpad(p)).toEqual(msg);
  const nonZero = p.slice();
  nonZero[100] = 1;
  expect(() => unpad(nonZero)).toThrow(CryptoError);
  const tooLong = p.slice();
  tooLong[3] = 200;
  expect(() => unpad(tooLong)).toThrow(CryptoError);
  expect(() => unpad(p.subarray(0, 64))).toThrow(CryptoError); // not a bucket size
});
