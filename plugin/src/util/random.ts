// Randomness is injected everywhere so tests and the convergence suite can
// replay a run exactly from a seed.

export interface Random {
  /** n random bytes. */
  bytes(n: number): Uint8Array<ArrayBuffer>;
  /** A float in [0, 1), for jitter and simulation. */
  float(): number;
}

export const cryptoRandom: Random = {
  bytes(n) {
    const out = new Uint8Array(n);
    // getRandomValues fills at most 65536 bytes per call.
    for (let off = 0; off < n; off += 65536) crypto.getRandomValues(out.subarray(off, Math.min(n, off + 65536)));
    return out;
  },
  float() {
    return crypto.getRandomValues(new Uint32Array(1))[0]! / 2 ** 32;
  },
};

/**
 * A deterministic PRNG (sfc32 seeded through splitmix32). Never use it for
 * real keys: it exists for tests and simulations.
 */
export function seededRandom(seed: number): Random & { int(maxExclusive: number): number; pick<T>(xs: readonly T[]): T } {
  let s = seed >>> 0;
  const split = () => {
    s = (s + 0x9e3779b9) >>> 0;
    let z = s;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
    return (z ^ (z >>> 16)) >>> 0;
  };
  let a = split(), b = split(), c = split(), d = split();
  const next = () => {
    const t = (((a + b) >>> 0) + d) >>> 0;
    d = (d + 1) >>> 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) >>> 0;
    c = ((c << 21) | (c >>> 11)) >>> 0;
    c = (c + t) >>> 0;
    return t;
  };
  const r = {
    bytes(n: number) {
      const out = new Uint8Array(n);
      for (let i = 0; i < n; i++) out[i] = next() & 0xff;
      return out;
    },
    float() {
      return next() / 2 ** 32;
    },
    int(maxExclusive: number) {
      return Math.floor(r.float() * maxExclusive);
    },
    pick<T>(xs: readonly T[]): T {
      if (xs.length === 0) throw new Error('pick from an empty list');
      return xs[r.int(xs.length)]!;
    },
  };
  return r;
}
