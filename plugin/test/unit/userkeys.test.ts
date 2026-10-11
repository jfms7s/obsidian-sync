import { describe, expect, it } from 'vitest';
import { CryptoError } from '../../src/crypto/primitives';
import {
  Argon2TooCostlyError, checkArgon2Params, CLIENT_ARGON2_MAX, createKeyBundle, derivePassKek, DEFAULT_ARGON2, InvalidRecoveryWordsError, rewrapPassphrase, strengthenParams, unlockWithPassphrase,
  unlockWithRecoveryWords, WrongPassphraseError, WrongRecoveryWordsError,
} from '../../src/crypto/userkeys';
import { seededRandom } from '../../src/util/random';

const USER = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const FAST = { memoryKib: 8192, iterations: 1, parallelism: 1 };

describe('key bundle', () => {
  it('unlocks with the passphrase or the recovery words, not otherwise', async () => {
    const created = await createKeyBundle(USER, 'pass phrase', seededRandom(7), FAST);
    expect(created.recoveryWords.split(' ')).toHaveLength(24);
    expect((await unlockWithPassphrase(created.bundle, USER, 'pass phrase')).encPriv).toEqual(created.keys.encPriv);
    expect((await unlockWithRecoveryWords(created.bundle, USER, created.recoveryWords)).signSeed).toEqual(created.keys.signSeed);
    await expect(unlockWithPassphrase(created.bundle, USER, 'wrong')).rejects.toBeInstanceOf(CryptoError);
    await expect(unlockWithPassphrase(created.bundle, 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'pass phrase')).rejects.toBeInstanceOf(CryptoError);
    const words = created.recoveryWords.split(' ');
    words[3] = words[3] === 'zoo' ? 'abandon' : 'zoo';
    await expect(unlockWithRecoveryWords(created.bundle, USER, words.join(' '))).rejects.toThrow();
    await expect(unlockWithRecoveryWords(created.bundle, USER, 'not words')).rejects.toBeInstanceOf(InvalidRecoveryWordsError);
  });

  it('says which secret was wrong: the passphrase or the recovery words', async () => {
    const created = await createKeyBundle(USER, 'pass phrase', seededRandom(70), FAST);
    const other = await createKeyBundle(USER, 'pass phrase', seededRandom(71), FAST);
    const wrongPass = await unlockWithPassphrase(created.bundle, USER, 'wrong').catch((e: unknown) => e);
    expect(wrongPass).toBeInstanceOf(WrongPassphraseError);
    expect(wrongPass).toBeInstanceOf(CryptoError);
    const wrongWords = await unlockWithRecoveryWords(created.bundle, USER, other.recoveryWords).catch((e: unknown) => e);
    expect(wrongWords).toBeInstanceOf(WrongRecoveryWordsError);
    expect(wrongWords).toBeInstanceOf(CryptoError);
  });

  it('changes the passphrase without touching the recovery wrapping, never below the default cost', async () => {
    const created = await createKeyBundle(USER, 'old', seededRandom(8), FAST);
    const changed = await rewrapPassphrase(created.bundle, USER, created.keys, 'new', seededRandom(9));
    expect(changed.recoveryWrapped).toEqual(created.bundle.recoveryWrapped);
    expect(changed.passParams).toEqual(DEFAULT_ARGON2); // FAST (8 MiB, 1 pass) is raised to the default
    expect((await unlockWithPassphrase(changed, USER, 'new')).encPriv).toEqual(created.keys.encPriv);
    await expect(unlockWithPassphrase(changed, USER, 'old')).rejects.toBeInstanceOf(CryptoError);
  });

  it('does not unlock a bundle whose parameters were changed', async () => {
    const created = await createKeyBundle(USER, 'pp', seededRandom(10), FAST);
    const weaker = { ...created.bundle, passParams: { ...FAST, iterations: 2 } };
    await expect(unlockWithPassphrase(weaker, USER, 'pp')).rejects.toBeInstanceOf(CryptoError);
  });

  it('keeps stronger stored parameters when rewrapping', () => {
    expect(strengthenParams({ memoryKib: 65536, iterations: 1, parallelism: 4 })).toEqual({ memoryKib: 65536, iterations: 2, parallelism: 4 });
  });

  it('refuses Argon2 parameters outside the server bounds', () => {
    expect(() => checkArgon2Params({ memoryKib: 4096, iterations: 1, parallelism: 1 })).toThrow(RangeError);
    expect(() => checkArgon2Params({ memoryKib: (4 << 20) + 1, iterations: 1, parallelism: 1 })).toThrow(RangeError);
    expect(() => checkArgon2Params({ memoryKib: 8192, iterations: 65, parallelism: 1 })).toThrow(RangeError);
    expect(() => checkArgon2Params({ memoryKib: 8192, iterations: 1, parallelism: 17 })).toThrow(RangeError);
    expect(() => checkArgon2Params({ memoryKib: 19456, iterations: 2, parallelism: 1 })).not.toThrow();
  });

  it('refuses to derive with server-supplied parameters above the device ceiling, before running Argon2', async () => {
    const created = await createKeyBundle(USER, 'pp', seededRandom(10), FAST);
    // Iterations first: without the ceiling this one runs Argon2 (8 MiB × 17) and fails later with a plain CryptoError.
    const slow = { ...created.bundle, passParams: { ...FAST, iterations: CLIENT_ARGON2_MAX.iterations + 1 } };
    await expect(unlockWithPassphrase(slow, USER, 'pp')).rejects.toBeInstanceOf(Argon2TooCostlyError);
    await expect(unlockWithPassphrase(slow, USER, 'pp')).rejects.toThrow(/more than this device allows/);
    const big = { ...created.bundle, passParams: { ...FAST, memoryKib: CLIENT_ARGON2_MAX.memoryKib + 1 } };
    await expect(unlockWithPassphrase(big, USER, 'pp')).rejects.toBeInstanceOf(Argon2TooCostlyError);
    await expect(derivePassKek('pp', created.bundle.passSalt, { memoryKib: 4 << 20, iterations: 1, parallelism: 1 })).rejects.toBeInstanceOf(CryptoError);
    expect(CLIENT_ARGON2_MAX.memoryKib).toBe(1 << 20);
  });
});
