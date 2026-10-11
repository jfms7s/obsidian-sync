// RFC 6238 codes for tests, from a base32 secret as the server hands it out.
import { createHmac } from 'node:crypto';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Decode(s: string): Buffer {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of s.replace(/[\s=]/g, '').toUpperCase()) {
    const i = ALPHABET.indexOf(ch);
    if (i < 0) throw new Error(`not base32: ${ch}`);
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** The code for secret (base32) at time nowMs, stepOffset steps away. */
export function totpCode(secret: string, nowMs = Date.now(), stepOffset = 0): string {
  const step = Math.floor(nowMs / 30_000) + stepOffset;
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const sum = createHmac('sha1', base32Decode(secret)).update(msg).digest();
  const off = sum[sum.length - 1]! & 0x0f;
  const bin = sum.readUInt32BE(off) & 0x7fffffff;
  return String(bin % 1_000_000).padStart(6, '0');
}
