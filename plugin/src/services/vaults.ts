// Remote vault services: list (with decrypted names), create, choose.
import type { ApiClient } from '../api/client';
import type { SealedVaultKey } from '../api/types';
import { decryptVaultName, encryptVaultName } from '../crypto/objects';
import type { UserKeys } from '../crypto/userkeys';
import { buildKeyring, deriveEpochKeys, openSealedKey, sealKey, type VaultKeyring } from '../crypto/vaultkeys';
import type { LocalState, Session, StoredVault } from '../state/store';
import { toHex } from '../util/bytes';
import { cryptoRandom, type Random } from '../util/random';

export interface RemoteVaultSummary {
  vaultId: string;
  /** null if the name could not be decrypted with this account's keys. */
  name: string | null;
  seq: number;
  createdAtMs: number;
  owned: boolean;
}

/**
 * Opens every sealed key of a vault for this user. In sub-project 1 every
 * key is sealed by the user's own devices, so the seals must carry the
 * user's own signature; sub-project 3 checks a sharer's pinned key instead.
 */
export async function openVaultKeys(sealed: SealedVaultKey[], vaultId: string, session: Session, keys: UserKeys): Promise<{ namingKey: Uint8Array; epochKeys: Map<number, Uint8Array> }> {
  let namingKey: Uint8Array | null = null;
  const epochKeys = new Map<number, Uint8Array>();
  for (const k of sealed) {
    const raw = await openSealedKey(k.sealedKey, keys.encPriv, vaultId, k.epoch, session.userId, keys.signPub);
    if (k.epoch === 0) namingKey = raw;
    else epochKeys.set(k.epoch, raw);
  }
  if (!namingKey) throw new Error(`vault ${vaultId} has no naming key for this account`);
  return { namingKey, epochKeys };
}

export async function listRemoteVaults(api: ApiClient, session: Session, keys: UserKeys): Promise<RemoteVaultSummary[]> {
  const out: RemoteVaultSummary[] = [];
  for (const v of await api.listVaults()) {
    let name: string | null = null;
    try {
      const opened = await openVaultKeys(await api.vaultKeys(v.vaultId), v.vaultId, session, keys);
      name = await decryptVaultName(await buildKeyring(v.vaultId, opened.namingKey, opened.epochKeys, v.currentEpoch), v.encName, keys.signPub);
    } catch {
      name = null;
    }
    out.push({ vaultId: v.vaultId, name, seq: v.seq, createdAtMs: v.createdAtMs, owned: v.ownerId === session.userId });
  }
  return out;
}

/** Creates a remote vault (naming key + epoch 1, sealed to this user) and makes it this device's vault. */
export async function createVault(state: LocalState, api: ApiClient, session: Session, keys: UserKeys, name: string, random: Random = cryptoRandom): Promise<StoredVault> {
  const vaultId = toHex(random.bytes(16));
  const namingKey = random.bytes(32);
  const epochKey = random.bytes(32);
  const epoch1 = await deriveEpochKeys(vaultId, 1, epochKey);
  const sealed: SealedVaultKey[] = [
    { epoch: 0, sealedKey: await sealKey(random, keys.encPub, namingKey, vaultId, 0, session.userId, keys.signSeed) },
    { epoch: 1, sealedKey: await sealKey(random, keys.encPub, epochKey, vaultId, 1, session.userId, keys.signSeed) },
  ];
  await api.createVault(vaultId, await encryptVaultName(random, vaultId, epoch1, name, keys.signSeed), sealed);
  const stored: StoredVault = { vaultId, name: name.normalize('NFC'), namingKey, epochKeys: [[1, epochKey]], currentEpoch: 1 };
  await state.resetVaultState();
  await state.setVault(stored);
  return stored;
}

/** Makes an existing remote vault this device's vault. Switching vaults drops the old vault's sync state. */
export async function chooseVault(state: LocalState, api: ApiClient, session: Session, keys: UserKeys, vaultId: string): Promise<StoredVault> {
  const v = (await api.listVaults()).find((x) => x.vaultId === vaultId);
  if (!v) throw new Error(`vault ${vaultId} not found`);
  const opened = await openVaultKeys(await api.vaultKeys(vaultId), vaultId, session, keys);
  const ring = await buildKeyring(vaultId, opened.namingKey, opened.epochKeys, v.currentEpoch);
  const stored: StoredVault = {
    vaultId, name: await decryptVaultName(ring, v.encName, keys.signPub), namingKey: opened.namingKey,
    epochKeys: [...opened.epochKeys.entries()], currentEpoch: v.currentEpoch,
  };
  const previous = await state.getVault();
  if (previous?.vaultId !== vaultId) await state.resetVaultState();
  await state.setVault(stored);
  return stored;
}

export function keyringFromStored(v: StoredVault): Promise<VaultKeyring> {
  return buildKeyring(v.vaultId, v.namingKey, new Map(v.epochKeys), v.currentEpoch);
}

/** Re-reads the vault's epoch and keys (after STALE_EPOCH). */
export async function refreshKeyring(state: LocalState, api: ApiClient, session: Session, keys: UserKeys): Promise<VaultKeyring> {
  const stored = await state.getVault();
  if (!stored) throw new Error('no vault chosen');
  return keyringFromStored(await chooseVault(state, api, session, keys, stored.vaultId));
}
