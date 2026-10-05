import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { describe, expect, it } from 'vitest';
import { CryptoError } from '../../src/crypto/primitives';
import { buildKeyring, epochKeys, openSealedKey, sealKey, SEALED_KEY_LEN } from '../../src/crypto/vaultkeys';
import { seededRandom } from '../../src/util/random';

const VAULT = '0123456789abcdef0123456789abcdef';
const USER = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

describe('sealed keys', () => {
  const r = seededRandom(6);
  const priv = r.bytes(32);
  const signSeed = r.bytes(32);
  const signPub = ed25519.getPublicKey(signSeed);
  const key = r.bytes(32);

  it('open only for the recipient, vault, epoch, user and signer they were sealed for', async () => {
    const sealed = await sealKey(r, x25519.getPublicKey(priv), key, VAULT, 1, USER, signSeed);
    expect(sealed.length).toBe(SEALED_KEY_LEN);
    expect(await openSealedKey(sealed, priv, VAULT, 1, USER, signPub)).toEqual(key);
    await expect(openSealedKey(sealed, r.bytes(32), VAULT, 1, USER, signPub)).rejects.toBeInstanceOf(CryptoError);
    await expect(openSealedKey(sealed, priv, VAULT, 2, USER, signPub)).rejects.toBeInstanceOf(CryptoError);
    await expect(openSealedKey(sealed, priv, VAULT, 1, 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', signPub)).rejects.toBeInstanceOf(CryptoError);
    await expect(openSealedKey(sealed, priv, VAULT, 1, USER, ed25519.getPublicKey(r.bytes(32)))).rejects.toBeInstanceOf(CryptoError);
  });

  it('rejects a key a server sealed to the user itself (a forged seal)', async () => {
    // Anyone can seal to a public key; only the signature tells the seals apart.
    const serverSeed = r.bytes(32);
    const forged = await sealKey(r, x25519.getPublicKey(priv), r.bytes(32), VAULT, 1, USER, serverSeed);
    await expect(openSealedKey(forged, priv, VAULT, 1, USER, signPub)).rejects.toThrow(/not signed by the expected key/);
  });

  it('refuses a low-order ephemeral key', async () => {
    const sealed = await sealKey(r, x25519.getPublicKey(priv), key, VAULT, 1, USER, signSeed);
    const zeroEph = sealed.slice();
    zeroEph.fill(0, 0, 32); // also breaks the signature: either check must refuse it
    await expect(openSealedKey(zeroEph, priv, VAULT, 1, USER, signPub)).rejects.toBeInstanceOf(CryptoError);
  });
});

describe('keyring', () => {
  it('needs the current epoch and names a missing one', async () => {
    const r = seededRandom(2);
    await expect(buildKeyring(VAULT, r.bytes(32), new Map([[1, r.bytes(32)]]), 2)).rejects.toBeInstanceOf(CryptoError);
    const ring = await buildKeyring(VAULT, r.bytes(32), new Map([[1, r.bytes(32)]]), 1);
    expect(() => epochKeys(ring, 3)).toThrow(/epoch 3/);
  });
});
