// Every domain-separation label and every AAD layout, in one place. The
// normative text is the project's crypto and encoding specification, kept
// with its design docs outside this repository; this file must match it byte
// for byte. The known-answer vectors (server/cmd/vectorgen, an independent
// Go reading of the same specification) enforce that both readings agree.
import { concat, fromHex, u32be, utf8 } from '../util/bytes';

export const LABEL = {
  contentKey: 'obsync/v1/content-key',
  metaKey: 'obsync/v1/meta-key',
  chunkIdKey: 'obsync/v1/chunk-id-key',
  vaultNameKey: 'obsync/v1/vault-name-key',
  chunkAad: 'obsync/v1/chunk',
  metaAad: 'obsync/v1/meta',
  vaultNameAad: 'obsync/v1/vault-name',
  sealInfo: 'obsync/v1/seal',
  sealAad: 'obsync/v1/sealed-key',
  sealSig: 'obsync/v1/sealed-key-sig',
  vaultNameSig: 'obsync/v1/vault-name-sig',
  recoveryKek: 'obsync/v1/recovery-kek',
  passAad: 'obsync/v1/keys-pass',
  recoveryAad: 'obsync/v1/keys-recovery',
} as const;

/** A 32-hex-character id (vault, user) as its 16 raw bytes. */
export function idBytes(hexId: string): Uint8Array<ArrayBuffer> {
  if (!/^[0-9a-f]{32}$/.test(hexId)) throw new Error(`id must be 32 lowercase hex characters: ${hexId}`);
  return fromHex(hexId);
}

function fixed(b: Uint8Array, n: number, what: string): Uint8Array {
  if (b.length !== n) throw new RangeError(`${what} must be ${n} bytes, got ${b.length}`);
  return b;
}

/** HKDF info for an epoch subkey: label ‖ u32be(epoch). */
export function epochInfo(label: string, epoch: number): Uint8Array<ArrayBuffer> {
  return concat(utf8(label), u32be(epoch));
}

export function chunkAad(vaultId: string, epoch: number, chunkId: Uint8Array): Uint8Array<ArrayBuffer> {
  return concat(utf8(LABEL.chunkAad), idBytes(vaultId), u32be(epoch), fixed(chunkId, 32, 'chunk_id'));
}

export function metaAad(vaultId: string, epoch: number, fileId: Uint8Array, versionId: Uint8Array): Uint8Array<ArrayBuffer> {
  return concat(utf8(LABEL.metaAad), idBytes(vaultId), u32be(epoch), fixed(fileId, 32, 'file_id'), fixed(versionId, 16, 'version_id'));
}

export function vaultNameAad(vaultId: string, epoch: number): Uint8Array<ArrayBuffer> {
  return concat(utf8(LABEL.vaultNameAad), idBytes(vaultId), u32be(epoch));
}

export function sealInfo(ephemeralPub: Uint8Array, recipientPub: Uint8Array): Uint8Array<ArrayBuffer> {
  return concat(utf8(LABEL.sealInfo), fixed(ephemeralPub, 32, 'ephemeral key'), fixed(recipientPub, 32, 'recipient key'));
}

export function sealAad(vaultId: string, epoch: number, userId: string): Uint8Array<ArrayBuffer> {
  return concat(utf8(LABEL.sealAad), idBytes(vaultId), u32be(epoch), idBytes(userId));
}

/** AAD of recovery_wrapped: label ‖ user_id ‖ public_enc_key ‖ public_sign_key. */
export function recoveryAad(userId: string, encPub: Uint8Array, signPub: Uint8Array): Uint8Array<ArrayBuffer> {
  return concat(utf8(LABEL.recoveryAad), idBytes(userId), fixed(encPub, 32, 'public_enc_key'), fixed(signPub, 32, 'public_sign_key'));
}

/**
 * AAD of pass_wrapped: the recovery layout plus the KDF inputs,
 * u8(len(salt)) ‖ salt ‖ u32be(memory_kib) ‖ u32be(iterations) ‖ u32be(parallelism),
 * so a server cannot swap in a weaker salt or parameters unnoticed.
 */
export function passAad(
  userId: string, encPub: Uint8Array, signPub: Uint8Array, salt: Uint8Array, p: { memoryKib: number; iterations: number; parallelism: number },
): Uint8Array<ArrayBuffer> {
  if (salt.length < 1 || salt.length > 255) throw new RangeError('salt must be 1 to 255 bytes');
  return concat(
    utf8(LABEL.passAad), idBytes(userId), fixed(encPub, 32, 'public_enc_key'), fixed(signPub, 32, 'public_sign_key'),
    new Uint8Array([salt.length]), salt, u32be(p.memoryKib), u32be(p.iterations), u32be(p.parallelism),
  );
}

export function recoveryInfo(userId: string): Uint8Array<ArrayBuffer> {
  return concat(utf8(LABEL.recoveryKek), idBytes(userId));
}

/** The message the sealer signs: label ‖ vault_id ‖ u32be(epoch) ‖ recipient user_id ‖ sealed (92 bytes). */
export function sealSigMessage(vaultId: string, epoch: number, recipientUserId: string, sealedCore: Uint8Array): Uint8Array<ArrayBuffer> {
  return concat(utf8(LABEL.sealSig), idBytes(vaultId), u32be(epoch), idBytes(recipientUserId), fixed(sealedCore, 92, 'sealed key'));
}

/** The message the vault's creator signs: label ‖ vault_id ‖ u32be(epoch) ‖ enc_name without its signature. */
export function vaultNameSigMessage(vaultId: string, epoch: number, encNameCore: Uint8Array): Uint8Array<ArrayBuffer> {
  return concat(utf8(LABEL.vaultNameSig), idBytes(vaultId), u32be(epoch), encNameCore);
}
