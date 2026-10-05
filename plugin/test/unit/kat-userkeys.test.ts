// Known-answer tests for the key bundle: vectors from server/cmd/vectorgen (Go).
import { describe, expect, it } from 'vitest';
import { passAad, recoveryAad } from '../../src/crypto/labels';
import {
  derivePassKek, deriveRecoveryKek, recoveryKeyToWords, unlockWithPassphrase, unlockWithRecoveryWords, userKeysFromSecrets,
  wordsToRecoveryKey, wrapPrivateKeys,
} from '../../src/crypto/userkeys';
import { fromHex as h, toHex } from '../../src/util/bytes';
import { loadVectors } from '../helpers/vectors';

interface UserKeyCase {
  user_id: string; enc_priv: string; enc_pub: string; sign_seed: string; sign_pub: string; passphrase_input: string;
  pass_salt: string; pass_params: { memory_kib: number; iterations: number; parallelism: number }; pass_kek: string;
  pass_nonce: string; pass_aad: string; pass_wrapped: string; recovery_key: string; recovery_words: string;
  recovery_kek: string; recovery_nonce: string; recovery_aad: string; recovery_wrapped: string;
}

describe('user key bundle vectors', () => {
  const v = loadVectors<{ cases: UserKeyCase[] }>('user-keys.json');
  it.each(v.cases)('user $user_id', async (c) => {
    const keys = userKeysFromSecrets(h(c.enc_priv), h(c.sign_seed));
    expect(toHex(keys.encPub)).toBe(c.enc_pub);
    expect(toHex(keys.signPub)).toBe(c.sign_pub);
    const params = { memoryKib: c.pass_params.memory_kib, iterations: c.pass_params.iterations, parallelism: c.pass_params.parallelism };
    const passKek = await derivePassKek(c.passphrase_input, h(c.pass_salt), params);
    expect(toHex(passKek)).toBe(c.pass_kek);
    const binding = { kind: 'pass' as const, salt: h(c.pass_salt), params };
    expect(toHex(passAad(c.user_id, keys.encPub, keys.signPub, h(c.pass_salt), params))).toBe(c.pass_aad);
    expect(toHex(await wrapPrivateKeys(passKek, h(c.pass_nonce), binding, c.user_id, keys))).toBe(c.pass_wrapped);
    expect(recoveryKeyToWords(h(c.recovery_key))).toBe(c.recovery_words);
    const recKek = await deriveRecoveryKek(h(c.recovery_key), c.user_id);
    expect(toHex(recKek)).toBe(c.recovery_kek);
    expect(toHex(recoveryAad(c.user_id, keys.encPub, keys.signPub))).toBe(c.recovery_aad);
    expect(toHex(await wrapPrivateKeys(recKek, h(c.recovery_nonce), { kind: 'recovery' }, c.user_id, keys))).toBe(c.recovery_wrapped);

    const bundle = {
      publicEncKey: keys.encPub, publicSignKey: keys.signPub, passSalt: h(c.pass_salt), passParams: params,
      passWrapped: h(c.pass_wrapped), recoveryWrapped: h(c.recovery_wrapped),
    };
    expect(toHex((await unlockWithPassphrase(bundle, c.user_id, c.passphrase_input)).encPriv)).toBe(c.enc_priv);
    const typed = `  ${c.recovery_words.toUpperCase().split(' ').join('\n ')}  `;
    expect(toHex((await unlockWithRecoveryWords(bundle, c.user_id, typed)).signSeed)).toBe(c.sign_seed);
  });
});

describe('BIP39 reference vectors', () => {
  const v = loadVectors<{ cases: Array<{ entropy: string; words: string }> }>('bip39.json');
  it.each(v.cases)('$entropy', (c) => {
    expect(recoveryKeyToWords(h(c.entropy))).toBe(c.words);
    expect(toHex(wordsToRecoveryKey(c.words))).toBe(c.entropy);
  });
});
