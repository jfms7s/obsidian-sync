/** A protobuf 64-bit integer as a number, refusing one a double cannot hold exactly. */
export function toSafeNumber(v: bigint, what: string): number {
  if (v > BigInt(Number.MAX_SAFE_INTEGER) || v < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new RangeError(`${what} ${v} is outside the range a number holds exactly`);
  }
  return Number(v);
}
