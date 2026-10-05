// The user's long-term keypairs and the key bundle that stores them on the
// server, wrapped under the passphrase and under the recovery key (spec §6.2).
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { argon2idAsync } from '@noble/hashes/argon2.js';
import { entropyToMnemonic, mnemonicToEntropy } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { equalBytes, utf8 } from '../util/bytes';
import type { Random } from '../util/random';
import { passAad, recoveryAad, recoveryInfo } from './labels';
import { aesGcmOpen, aesGcmSeal, CryptoError, hkdfSha256, NONCE_LEN } from './primitives';

export interface Argon2Params {
  memoryKib: number;
  iterations: number;
  parallelism: number;
}

/** About 1 s on a mid-range phone with the pure-JS Argon2id (0.5 s on a laptop). */
export const DEFAULT_ARGON2: Argon2Params = { memoryKib: 19456, iterations: 2, parallelism: 1 };

/** The server's bounds (server/internal/api/keys.go). */
export const ARGON2_LIMITS = { minMemoryKib: 8192, maxMemoryKib: 4 << 20, maxIterations: 64, maxParallelism: 16 } as const;

export const PASS_SALT_LEN = 16;
export const RECOVERY_KEY_LEN = 32;

export interface UserKeys {
  encPriv: Uint8Array; // X25519 private key
  encPub: Uint8Array;
  signSeed: Uint8Array; // Ed25519 seed (RFC 8032 private key)
  signPub: Uint8Array;
}

/** The stored fields of obsync.v1.KeyBundle. */
export interface KeyBundleFields {
  publicEncKey: Uint8Array;
  publicSignKey: Uint8Array;
  passSalt: Uint8Array;
  passParams: Argon2Params;
  passWrapped: Uint8Array;
  recoveryWrapped: Uint8Array;
}

export function userKeysFromSecrets(encPriv: Uint8Array, signSeed: Uint8Array): UserKeys {
  if (encPriv.length !== 32 || signSeed.length !== 32) throw new RangeError('private keys must be 32 bytes');
  return { encPriv, encPub: x25519.getPublicKey(encPriv), signSeed, signPub: ed25519.getPublicKey(signSeed) };
}

export function generateUserKeys(random: Random): UserKeys {
  return userKeysFromSecrets(random.bytes(32), random.bytes(32));
}

export function checkArgon2Params(p: Argon2Params): void {
  const ok =
    Number.isInteger(p.memoryKib) && Number.isInteger(p.iterations) && Number.isInteger(p.parallelism) &&
    p.memoryKib >= ARGON2_LIMITS.minMemoryKib && p.memoryKib <= ARGON2_LIMITS.maxMemoryKib &&
    p.iterations >= 1 && p.iterations <= ARGON2_LIMITS.maxIterations &&
    p.parallelism >= 1 && p.parallelism <= ARGON2_LIMITS.maxParallelism &&
    p.memoryKib >= 8 * p.parallelism;
  if (!ok) throw new RangeError(`argon2 parameters out of range: ${JSON.stringify(p)}`);
}

/** KEK_pass = Argon2id(UTF-8(NFC(passphrase)), salt, params), 32 bytes, version 0x13. */
export async function derivePassKek(passphrase: string, salt: Uint8Array, params: Argon2Params): Promise<Uint8Array> {
  checkArgon2Params(params);
  return argon2idAsync(utf8(passphrase.normalize('NFC')), salt, {
    m: params.memoryKib,
    t: params.iterations,
    p: params.parallelism,
    dkLen: 32,
    maxmem: params.memoryKib * 1024 + (1 << 20),
    asyncTick: 20,
  });
}

/** KEK_recovery = HKDF-SHA256(recovery_key, salt = empty, info = label ‖ user_id). */
export function deriveRecoveryKek(recoveryKey: Uint8Array, userId: string): Promise<Uint8Array> {
  if (recoveryKey.length !== RECOVERY_KEY_LEN) throw new RangeError('recovery key must be 32 bytes');
  return hkdfSha256(recoveryKey, new Uint8Array(0), recoveryInfo(userId));
}

/** The recovery key as 24 BIP39 English words (its 256 bits are the entropy; no BIP39 seed is derived). */
export function recoveryKeyToWords(recoveryKey: Uint8Array): string {
  if (recoveryKey.length !== RECOVERY_KEY_LEN) throw new RangeError('recovery key must be 32 bytes');
  return entropyToMnemonic(recoveryKey, wordlist);
}

export class InvalidRecoveryWordsError extends Error {
  constructor() {
    super('the recovery words are not valid: check for typos and that all 24 words are present');
    this.name = 'InvalidRecoveryWordsError';
  }
}

/** Parses recovery words typed by a person: any case and any whitespace between words. */
export function wordsToRecoveryKey(words: string): Uint8Array {
  const normalized = words.normalize('NFKD').toLowerCase().trim().split(/\s+/).join(' ');
  let entropy: Uint8Array;
  try {
    entropy = mnemonicToEntropy(normalized, wordlist);
  } catch {
    throw new InvalidRecoveryWordsError();
  }
  if (entropy.length !== RECOVERY_KEY_LEN) throw new InvalidRecoveryWordsError();
  return entropy;
}

/** Where a wrapping's AAD comes from: the passphrase wrapping also binds its salt and Argon2 parameters. */
export type WrapBinding =
  | { kind: 'pass'; salt: Uint8Array; params: Argon2Params }
  | { kind: 'recovery' };

function wrapAad(b: WrapBinding, userId: string, encPub: Uint8Array, signPub: Uint8Array): Uint8Array {
  return b.kind === 'pass' ? passAad(userId, encPub, signPub, b.salt, b.params) : recoveryAad(userId, encPub, signPub);
}

/** nonce ‖ AES-256-GCM(kek, encPriv ‖ signSeed, AAD per the binding). */
export function wrapPrivateKeys(kek: Uint8Array, nonce: Uint8Array, binding: WrapBinding, userId: string, keys: UserKeys): Promise<Uint8Array> {
  const plaintext = new Uint8Array(64);
  plaintext.set(keys.encPriv, 0);
  plaintext.set(keys.signSeed, 32);
  return aesGcmSeal(kek, nonce, plaintext, wrapAad(binding, userId, keys.encPub, keys.signPub));
}

export async function unwrapPrivateKeys(
  kek: Uint8Array, wrapped: Uint8Array, binding: WrapBinding, userId: string, encPub: Uint8Array, signPub: Uint8Array,
): Promise<UserKeys> {
  const pt = await aesGcmOpen(kek, wrapped, wrapAad(binding, userId, encPub, signPub));
  if (pt.length !== 64) throw new CryptoError('wrapped private keys have the wrong length');
  const keys = userKeysFromSecrets(pt.slice(0, 32), pt.slice(32, 64));
  if (!equalBytes(keys.encPub, encPub) || !equalBytes(keys.signPub, signPub)) {
    throw new CryptoError('private keys do not match the public keys');
  }
  return keys;
}

export interface NewKeyBundle {
  bundle: KeyBundleFields;
  keys: UserKeys;
  recoveryKey: Uint8Array;
  recoveryWords: string;
}

/** First-time setup: new keypairs, a new recovery key, and both wrappings. */
export async function createKeyBundle(userId: string, passphrase: string, random: Random, params: Argon2Params = DEFAULT_ARGON2): Promise<NewKeyBundle> {
  const keys = generateUserKeys(random);
  const recoveryKey = random.bytes(RECOVERY_KEY_LEN);
  const bundle = await wrapBundle(userId, keys, passphrase, recoveryKey, random, params);
  return { bundle, keys, recoveryKey, recoveryWords: recoveryKeyToWords(recoveryKey) };
}

async function wrapBundle(userId: string, keys: UserKeys, passphrase: string, recoveryKey: Uint8Array, random: Random, params: Argon2Params): Promise<KeyBundleFields> {
  const passSalt = random.bytes(PASS_SALT_LEN);
  const passKek = await derivePassKek(passphrase, passSalt, params);
  const passWrapped = await wrapPrivateKeys(passKek, random.bytes(NONCE_LEN), { kind: 'pass', salt: passSalt, params }, userId, keys);
  const recoveryWrapped = await wrapPrivateKeys(await deriveRecoveryKek(recoveryKey, userId), random.bytes(NONCE_LEN), { kind: 'recovery' }, userId, keys);
  return { publicEncKey: keys.encPub, publicSignKey: keys.signPub, passSalt, passParams: params, passWrapped, recoveryWrapped };
}

export async function unlockWithPassphrase(bundle: KeyBundleFields, userId: string, passphrase: string): Promise<UserKeys> {
  const kek = await derivePassKek(passphrase, bundle.passSalt, bundle.passParams);
  return unwrapPrivateKeys(kek, bundle.passWrapped, { kind: 'pass', salt: bundle.passSalt, params: bundle.passParams }, userId, bundle.publicEncKey, bundle.publicSignKey);
}

export async function unlockWithRecoveryWords(bundle: KeyBundleFields, userId: string, words: string): Promise<UserKeys> {
  const kek = await deriveRecoveryKek(wordsToRecoveryKey(words), userId);
  return unwrapPrivateKeys(kek, bundle.recoveryWrapped, { kind: 'recovery' }, userId, bundle.publicEncKey, bundle.publicSignKey);
}

/** Each parameter at least DEFAULT_ARGON2's, so a rewrap never weakens the KDF below today's default. */
export function strengthenParams(p: Argon2Params): Argon2Params {
  return {
    memoryKib: Math.max(p.memoryKib, DEFAULT_ARGON2.memoryKib),
    iterations: Math.max(p.iterations, DEFAULT_ARGON2.iterations),
    parallelism: Math.max(p.parallelism, DEFAULT_ARGON2.parallelism),
  };
}

/**
 * A passphrase change: a new salt and pass_wrapped; recovery_wrapped is
 * kept as it is. The parameters are the stored ones raised to at least
 * DEFAULT_ARGON2 (never lowered: the stored ones come from the server).
 */
export async function rewrapPassphrase(bundle: KeyBundleFields, userId: string, keys: UserKeys, newPassphrase: string, random: Random): Promise<KeyBundleFields> {
  const params = strengthenParams(bundle.passParams);
  const passSalt = random.bytes(PASS_SALT_LEN);
  const kek = await derivePassKek(newPassphrase, passSalt, params);
  const passWrapped = await wrapPrivateKeys(kek, random.bytes(NONCE_LEN), { kind: 'pass', salt: passSalt, params }, userId, keys);
  return { ...bundle, passSalt, passParams: params, passWrapped };
}
