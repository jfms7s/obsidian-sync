// Reject vectors from server/cmd/vectorgen (Go): well-formed inputs that
// break exactly one rule. Each must fail with CryptoError.
import { describe, expect, it } from 'vitest';
import { decryptMeta, decryptVaultName } from '../../src/crypto/objects';
import { CryptoError } from '../../src/crypto/primitives';
import { buildKeyring, openSealedKey, sealKey } from '../../src/crypto/vaultkeys';
import { fromHex as h } from '../../src/util/bytes';
import { seededRandom } from '../../src/util/random';
import { loadVectors } from '../helpers/vectors';

interface Rejects {
  small_order_points: string[];
  sealed_keys: Array<{ why: string; vault_id: string; epoch: number; user_id: string; recipient_priv: string; sealer_pub: string; sealed: string }>;
  meta: { vault_id: string; epoch: number; epoch_key: string; naming_key: string; cases: Array<{ why: string; file_id: string; version_id: string; enc_meta: string }> };
  vault_names: { vault_id: string; epoch: number; epoch_key: string; signer_pub: string; cases: Array<{ why: string; enc_name: string }> };
}

const v = loadVectors<Rejects>('rejects.json');

describe('sealed key reject vectors', () => {
  it.each(v.sealed_keys)('$why', async (c) => {
    await expect(openSealedKey(h(c.sealed), h(c.recipient_priv), c.vault_id, c.epoch, c.user_id, h(c.sealer_pub))).rejects.toBeInstanceOf(CryptoError);
  });

  it.each(v.small_order_points)('refuses to seal to small-order recipient %s', async (p) => {
    const vault = '0123456789abcdef0123456789abcdef', user = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    await expect(sealKey(seededRandom(1), h(p), new Uint8Array(32), vault, 1, user, new Uint8Array(32))).rejects.toBeInstanceOf(CryptoError);
  });
});

describe('file metadata reject vectors', () => {
  it.each(v.meta.cases)('$why', async (c) => {
    const ring = await buildKeyring(v.meta.vault_id, h(v.meta.naming_key), new Map([[v.meta.epoch, h(v.meta.epoch_key)]]), v.meta.epoch);
    await expect(decryptMeta(ring, v.meta.epoch, h(c.file_id), h(c.version_id), h(c.enc_meta))).rejects.toBeInstanceOf(CryptoError);
  });
});

describe('vault name reject vectors', () => {
  it.each(v.vault_names.cases)('$why', async (c) => {
    const ring = await buildKeyring(v.vault_names.vault_id, new Uint8Array(32), new Map([[v.vault_names.epoch, h(v.vault_names.epoch_key)]]), v.vault_names.epoch);
    await expect(decryptVaultName(ring, h(c.enc_name), h(v.vault_names.signer_pub))).rejects.toBeInstanceOf(CryptoError);
  });
});
