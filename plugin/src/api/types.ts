// The client's view of protocol messages: plain objects with numbers where
// the wire has 64-bit integers (seqs and sizes stay far below 2^53).
import type { Argon2Params, KeyBundleFields } from '../crypto/userkeys';

export type { Argon2Params, KeyBundleFields };

export interface LoginResult {
  token: string;
  deviceId: string;
  userId: string;
}

export interface DeviceInfo {
  deviceId: string;
  name: string;
  platform: string;
  createdAtMs: number;
  lastSeenAtMs: number;
  current: boolean;
  revoked: boolean;
}

export interface SealedVaultKey {
  epoch: number;
  sealedKey: Uint8Array;
}

export interface VaultInfo {
  vaultId: string;
  encName: Uint8Array;
  currentEpoch: number;
  seq: number;
  createdAtMs: number;
  ownerId: string;
}

export interface CommitInput {
  fileId: Uint8Array;
  versionId: Uint8Array;
  baseVersionId: Uint8Array; // empty = the client believes the file is new
  epoch: number;
  encMeta: Uint8Array;
  chunkIds: Uint8Array[];
  size: number;
  deleted: boolean;
}

export interface CommitOutcome {
  fileId: Uint8Array;
  ok: boolean;
  seq: number;
  error?: { code: number; message: string };
  headVersionId: Uint8Array; // with CONFLICT: the current head (empty if none)
}

export interface CommitReply {
  results: CommitOutcome[];
  vaultSeq: number;
}

export interface RemoteVersion {
  fileId: Uint8Array;
  versionId: Uint8Array;
  baseVersionId: Uint8Array;
  epoch: number;
  encMeta: Uint8Array;
  chunkIds: Uint8Array[];
  size: number;
  deleted: boolean;
  deviceId: string;
  createdAtMs: number;
  seq: number;
}

export interface ChangesPage {
  versions: RemoteVersion[];
  vaultSeq: number;
  more: boolean;
}

export interface RemoteHead {
  fileId: Uint8Array;
  versionId: Uint8Array;
  seq: number;
  deleted: boolean;
}

export interface HeadsPage {
  heads: RemoteHead[];
  more: boolean;
}
