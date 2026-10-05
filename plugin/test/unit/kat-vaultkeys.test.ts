// Known-answer tests for epoch subkeys and sealed vault keys: vectors from server/cmd/vectorgen (Go).
import { describe, expect, it } from 'vitest';
import { sealAad, sealSigMessage } from '../../src/crypto/labels';
import { deriveEpochKeys, openSealedKey, sealKeyWith } from '../../src/crypto/vaultkeys';
import { fromHex as h, toHex } from '../../src/util/bytes';
import { loadVectors } from '../helpers/vectors';

describe('epoch subkey vectors', () => {
  const v = loadVectors<{ cases: Array<{ vault_id: string; epoch: number; epoch_key: string; content_key: string; meta_key: string; chunk_id_key: string; vault_name_key: string }> }>('epoch-keys.json');
  it.each(v.cases)('vault $vault_id epoch $epoch', async (c) => {
    const k = await deriveEpochKeys(c.vault_id, c.epoch, h(c.epoch_key));
    expect(toHex(k.contentKey)).toBe(c.content_key);
    expect(toHex(k.metaKey)).toBe(c.meta_key);
    expect(toHex(k.chunkIdKey)).toBe(c.chunk_id_key);
    expect(toHex(k.vaultNameKey)).toBe(c.vault_name_key);
  });
});

describe('sealed key vectors', () => {
  const v = loadVectors<{ cases: Array<{ vault_id: string; epoch: number; user_id: string; recipient_priv: string; recipient_pub: string; ephemeral_priv: string; key: string; nonce: string; aad: string; sealer_seed: string; sealer_pub: string; sig_message: string; sealed: string }> }>('sealed-keys.json');
  it.each(v.cases)('epoch $epoch', async (c) => {
    expect(toHex(sealAad(c.vault_id, c.epoch, c.user_id))).toBe(c.aad);
    expect(toHex(sealSigMessage(c.vault_id, c.epoch, c.user_id, h(c.sealed).subarray(0, 92)))).toBe(c.sig_message);
    const sealed = await sealKeyWith(h(c.ephemeral_priv), h(c.nonce), h(c.recipient_pub), h(c.key), c.vault_id, c.epoch, c.user_id, h(c.sealer_seed));
    expect(toHex(sealed)).toBe(c.sealed);
    expect(toHex(await openSealedKey(h(c.sealed), h(c.recipient_priv), c.vault_id, c.epoch, c.user_id, h(c.sealer_pub)))).toBe(c.key);
  });
});
