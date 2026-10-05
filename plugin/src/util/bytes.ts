// Byte helpers. Everything here is plain JS so it runs in Obsidian on
// desktop and mobile alike.

/** Returns b typed over a plain ArrayBuffer, as WebCrypto requires, copying only if needed. */
export function bs(b: Uint8Array): Uint8Array<ArrayBuffer> {
  return b.buffer instanceof ArrayBuffer ? (b as Uint8Array<ArrayBuffer>) : new Uint8Array(b);
}

export function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** Encodes n (0 ≤ n < 2^32) as 4 big-endian bytes. */
export function u32be(n: number): Uint8Array<ArrayBuffer> {
  if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) throw new RangeError(`u32 out of range: ${n}`);
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n, false);
  return out;
}

const encoder = new TextEncoder();
// ignoreBOM: a leading U+FEFF is kept, so decoding is the exact inverse of
// utf8() and a file's byte-order mark survives a round trip (e.g. a merge).
const lenient = new TextDecoder('utf-8', { ignoreBOM: true });
const strict = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export function utf8(s: string): Uint8Array<ArrayBuffer> {
  return encoder.encode(s);
}

/** Decodes UTF-8, replacing invalid sequences. */
export function fromUtf8(b: Uint8Array): string {
  return lenient.decode(b);
}

/** Decodes UTF-8, or returns null if b is not valid UTF-8. */
export function fromUtf8Strict(b: Uint8Array): string | null {
  try {
    return strict.decode(b);
  } catch {
    return null;
  }
}

export function toHex(b: Uint8Array): string {
  let s = '';
  for (const x of b) s += x.toString(16).padStart(2, '0');
  return s;
}

/** Decodes lowercase hex; throws on anything else. */
export function fromHex(s: string): Uint8Array<ArrayBuffer> {
  if (s.length % 2 !== 0 || !/^[0-9a-f]*$/.test(s)) throw new Error(`invalid hex: ${s.slice(0, 16)}`);
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(2 * i, 2 * i + 2), 16);
  return out;
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i]! ^ b[i]!;
  return d === 0;
}
