// Vault keys: the naming key (epoch 0), the epoch keys K_e, their HKDF
// subkeys, and sealing to a member's X25519 public key (spec §6.3).
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { concat, equalBytes } from '../util/bytes';
import type { Random } from '../util/random';
import { epochInfo, idBytes, LABEL, sealAad, sealInfo, sealSigMessage } from './labels';
import { aesGcmOpen, aesGcmSeal, CryptoError, hkdfSha256, KEY_LEN, NONCE_LEN } from './primitives';

export interface EpochKeys {
  epoch: number;
  contentKey: Uint8Array;
  metaKey: Uint8Array;
  chunkIdKey: Uint8Array;
  vaultNameKey: Uint8Array;
}

/** Subkey = HKDF-SHA256(K_e, salt = vault_id (16 bytes), info = label ‖ u32be(e)). */
export async function deriveEpochKeys(vaultId: string, epoch: number, epochKey: Uint8Array): Promise<EpochKeys> {
  if (epoch < 1) throw new RangeError('content epochs start at 1');
  if (epochKey.length !== KEY_LEN) throw new RangeError('epoch key must be 32 bytes');
  const salt = idBytes(vaultId);
  const sub = (label: string) => hkdfSha256(epochKey, salt, epochInfo(label, epoch));
  return {
    epoch,
    contentKey: await sub(LABEL.contentKey),
    metaKey: await sub(LABEL.metaKey),
    chunkIdKey: await sub(LABEL.chunkIdKey),
    vaultNameKey: await sub(LABEL.vaultNameKey),
  };
}

const SEALED_CORE_LEN = 32 + NONCE_LEN + KEY_LEN + 16; // 92
export const SIGNATURE_LEN = 64;
export const SEALED_KEY_LEN = SEALED_CORE_LEN + SIGNATURE_LEN; // 156

/**
 * sealed = core ‖ Ed25519(sealer, "obsync/v1/sealed-key-sig" ‖ vault_id ‖ u32be(epoch) ‖ user_id ‖ core)
 * core   = eph_pub ‖ nonce ‖ AES-256-GCM(kek, key, AAD = "obsync/v1/sealed-key" ‖ vault_id ‖ u32be(epoch) ‖ user_id)
 * where kek = HKDF-SHA256(X25519(eph_priv, recipient_pub), salt = empty, info = "obsync/v1/seal" ‖ eph_pub ‖ recipient_pub).
 * The signature lets the recipient check who sealed the key: an anonymous
 * seal could come from the server itself. The deterministic core: the
 * ephemeral key and nonce are inputs (Ed25519 signing is deterministic).
 */
/** @internal test-only: caller supplies nonce */
export async function sealKeyWith(
  ephPriv: Uint8Array, nonce: Uint8Array, recipientPub: Uint8Array, key: Uint8Array, vaultId: string, epoch: number, userId: string,
  sealerSignSeed: Uint8Array,
): Promise<Uint8Array> {
  if (key.length !== KEY_LEN) throw new RangeError('sealed keys are 32 bytes');
  const ephPub = x25519.getPublicKey(ephPriv);
  const kek = await sealKek(ephPriv, ephPub, recipientPub);
  const core = concat(ephPub, await aesGcmSeal(kek, nonce, key, sealAad(vaultId, epoch, userId)));
  return concat(core, ed25519.sign(sealSigMessage(vaultId, epoch, userId, core), sealerSignSeed));
}

export function sealKey(
  random: Random, recipientPub: Uint8Array, key: Uint8Array, vaultId: string, epoch: number, userId: string, sealerSignSeed: Uint8Array,
): Promise<Uint8Array> {
  return sealKeyWith(random.bytes(32), random.bytes(NONCE_LEN), recipientPub, key, vaultId, epoch, userId, sealerSignSeed);
}

/** Checks the sealer's signature, then opens the key. Throws CryptoError on any mismatch. */
export async function openSealedKey(
  sealed: Uint8Array, recipientPriv: Uint8Array, vaultId: string, epoch: number, userId: string, sealerSignPub: Uint8Array,
): Promise<Uint8Array> {
  if (sealed.length !== SEALED_KEY_LEN) throw new CryptoError('sealed key has the wrong length');
  const core = sealed.subarray(0, SEALED_CORE_LEN);
  if (!ed25519.verify(sealed.subarray(SEALED_CORE_LEN), sealSigMessage(vaultId, epoch, userId, core), sealerSignPub, { zip215: false })) {
    throw new CryptoError('sealed key is not signed by the expected key');
  }
  const ephPub = core.subarray(0, 32);
  const recipientPub = x25519.getPublicKey(recipientPriv);
  const kek = await sealKek(recipientPriv, recipientPub, ephPub, true);
  const key = await aesGcmOpen(kek, core.subarray(32), sealAad(vaultId, epoch, userId));
  if (key.length !== KEY_LEN) throw new CryptoError('sealed key has the wrong length');
  return key;
}

// The KEK depends on (eph_pub, recipient_pub) in that order on both sides.
async function sealKek(priv: Uint8Array, ownPub: Uint8Array, peerPub: Uint8Array, opening = false): Promise<Uint8Array> {
  let shared: Uint8Array;
  try {
    shared = x25519.getSharedSecret(priv, peerPub);
  } catch {
    throw new CryptoError('invalid X25519 public key');
  }
  if (equalBytes(shared, new Uint8Array(32))) throw new CryptoError('X25519 produced the all-zero secret');
  const [ephPub, recipientPub] = opening ? [peerPub, ownPub] : [ownPub, peerPub];
  return hkdfSha256(shared, new Uint8Array(0), sealInfo(ephPub, recipientPub));
}

/** A vault's unsealed keys, kept on the device. */
export interface VaultKeyring {
  vaultId: string;
  namingKey: Uint8Array;
  epochs: Map<number, EpochKeys>;
  currentEpoch: number;
}

export async function buildKeyring(vaultId: string, namingKey: Uint8Array, epochKeys: Map<number, Uint8Array>, currentEpoch: number): Promise<VaultKeyring> {
  const epochs = new Map<number, EpochKeys>();
  for (const [e, k] of epochKeys) epochs.set(e, await deriveEpochKeys(vaultId, e, k));
  if (!epochs.has(currentEpoch)) throw new CryptoError(`no key for the vault's current epoch ${currentEpoch}`);
  return { vaultId, namingKey, epochs, currentEpoch };
}

/**
 * This device has no key for an epoch a version uses: the keyring is out of
 * date (the vault was re-keyed), not the version broken. Fails the cycle,
 * which fetches the vault keys again, rather than one file.
 */
export class MissingEpochKeyError extends CryptoError {
  constructor(readonly epoch: number) {
    super(`no key for epoch ${epoch}`);
    this.name = 'MissingEpochKeyError';
  }
}

export function epochKeys(ring: VaultKeyring, epoch: number): EpochKeys {
  const k = ring.epochs.get(epoch);
  if (!k) throw new MissingEpochKeyError(epoch);
  return k;
}
