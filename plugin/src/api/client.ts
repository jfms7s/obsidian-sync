// HTTP client for the obsync API (server/internal/api). Protobuf bodies go
// as application/x-protobuf, chunk bodies as application/octet-stream. The
// client never retries on its own: callers decide, using isTemporary() and
// ApiError.retryAfterMs.
import { create, fromBinary, toBinary, type DescMessage, type MessageShape } from '@bufbuild/protobuf';
import {
  ChangesResponseSchema, ChunkExistsRequestSchema, ChunkExistsResponseSchema, CommitRequestSchema, CommitResponseSchema,
  CreateVaultRequestSchema, ErrorCode, ErrorSchema, HeadsResponseSchema, KeyBundleSchema, ListDevicesResponseSchema,
  ListVaultsResponseSchema, LoginRequestSchema, LoginResponseSchema, VaultKeysResponseSchema, VaultSchema,
  VersionsResponseSchema, type Vault, type Version,
} from '../gen/obsync/v1/obsync_pb';
import { bs, toHex, utf8 } from '../util/bytes';
import { systemClock, type Clock } from '../util/clock';
import { ApiError, NetworkError } from './errors';
import { RateGate } from './gate';
import { CHANGES_PAGE_SIZE, HEADS_PAGE_SIZE, MAX_COMMITS_PER_REQUEST, MAX_PASSWORD_BYTES } from './limits';
import type {
  ChangesPage, CommitInput, CommitReply, DeviceInfo, HeadsPage, KeyBundleFields, LoginResult, RemoteVersion,
  SealedVaultKey, VaultInfo,
} from './types';

export const PROTO = 'application/x-protobuf';
export const OCTETS = 'application/octet-stream';

/**
 * The HTTP transport. Plan 3 supplies one over Obsidian's requestUrl (no
 * CORS preflight); tests and other hosts use fetchTransport. Only whole,
 * buffered bodies are used: no streaming, no AbortSignal, no cookies.
 */
export interface HttpRequest {
  method: string;
  /** Header names as written here; a transport may lower-case them. */
  headers: Record<string, string>;
  body?: Uint8Array<ArrayBuffer>;
}

export interface HttpResponse {
  status: number;
  /** Case-insensitive lookup, like Headers.get. */
  headers: { get(name: string): string | null };
  /** The whole body; rejects if the connection broke mid-body. */
  arrayBuffer(): Promise<ArrayBuffer>;
}

/** Resolves for every HTTP status (errors included); rejects only when no response arrived. */
export type FetchLike = (url: string, req: HttpRequest) => Promise<HttpResponse>;

export const fetchTransport: FetchLike = (url, req) => {
  const init: RequestInit = { method: req.method, headers: req.headers, cache: 'no-store' };
  if (req.body) init.body = req.body;
  return globalThis.fetch(url, init);
};

export interface ApiClientOptions {
  baseUrl: string; // normalized by normalizeServerUrl
  token?: string;
  fetch?: FetchLike;
  clock?: Clock;
  gate?: RateGate;
}

interface CallOptions {
  body?: Uint8Array;
  contentType?: string;
  auth?: boolean;
}

/** Parses Retry-After (delta-seconds or an HTTP date) into milliseconds. */
export function parseRetryAfter(value: string | null, nowMs: number): number | undefined {
  if (value === null) return undefined;
  const v = value.trim();
  if (/^\d+$/.test(v)) return Number(v) * 1000;
  const at = Date.parse(v);
  return Number.isNaN(at) ? undefined : Math.max(0, at - nowMs);
}

function statusCode(status: number): ErrorCode {
  switch (status) {
    case 400: case 415: return ErrorCode.INVALID;
    case 401: return ErrorCode.UNAUTHORIZED;
    case 403: return ErrorCode.WRONG_PASSWORD;
    case 404: return ErrorCode.NOT_FOUND;
    case 409: return ErrorCode.CONFLICT;
    case 413: return ErrorCode.TOO_LARGE;
    case 429: return ErrorCode.RATE_LIMITED;
    case 507: return ErrorCode.QUOTA_EXCEEDED;
    default: return ErrorCode.INTERNAL;
  }
}

function versionFromProto(v: Version): RemoteVersion {
  return {
    fileId: v.fileId, versionId: v.versionId, baseVersionId: v.baseVersionId, epoch: v.epoch, encMeta: v.encMeta,
    chunkIds: v.chunkIds, size: Number(v.size), deleted: v.deleted, deviceId: v.deviceId,
    createdAtMs: Number(v.createdAtMs), seq: Number(v.seq),
  };
}

function vaultFromProto(v: Vault): VaultInfo {
  return {
    vaultId: v.vaultId, encName: v.encName, currentEpoch: v.currentEpoch, seq: Number(v.seq),
    createdAtMs: Number(v.createdAtMs), ownerId: v.ownerId,
  };
}

function checkPassword(p: string): void {
  if (utf8(p).length > MAX_PASSWORD_BYTES) throw new ApiError(ErrorCode.INVALID, `passwords are at most ${MAX_PASSWORD_BYTES} bytes`, 0);
}

export class ApiClient {
  readonly baseUrl: string;
  token: string | undefined;
  readonly gate: RateGate;
  private readonly fetchFn: FetchLike;
  private readonly clock: Clock;

  constructor(opts: ApiClientOptions) {
    this.baseUrl = opts.baseUrl;
    this.token = opts.token;
    this.clock = opts.clock ?? systemClock;
    this.gate = opts.gate ?? new RateGate(this.clock);
    this.fetchFn = opts.fetch ?? fetchTransport;
  }

  private async send(method: string, path: string, opts: CallOptions = {}): Promise<HttpResponse> {
    const wait = this.gate.remainingMs();
    if (wait > 0) throw new ApiError(ErrorCode.RATE_LIMITED, `rate limited; retry in ${Math.ceil(wait / 1000)} s`, 429, wait);
    const headers: Record<string, string> = {};
    if (opts.auth !== false) {
      if (!this.token) throw new ApiError(ErrorCode.UNAUTHORIZED, 'not logged in', 0);
      headers['Authorization'] = `Bearer ${this.token}`;
    }
    if (opts.body) headers['Content-Type'] = opts.contentType ?? PROTO;
    let resp: HttpResponse;
    try {
      const req: HttpRequest = { method, headers };
      if (opts.body) req.body = bs(opts.body);
      resp = await this.fetchFn(this.baseUrl + path, req);
    } catch (err) {
      throw new NetworkError(`${method} ${path}: ${(err as Error)?.message ?? String(err)}`, err);
    }
    if (resp.status >= 200 && resp.status < 300) return resp;
    throw await this.toError(resp);
  }

  private async toError(resp: HttpResponse): Promise<ApiError> {
    const retryAfterMs = parseRetryAfter(resp.headers.get('Retry-After'), this.clock.now());
    if (resp.status === 429 && retryAfterMs !== undefined) this.gate.block(retryAfterMs);
    let code = statusCode(resp.status);
    let message = `HTTP ${resp.status}`;
    if ((resp.headers.get('Content-Type') ?? '').startsWith(PROTO)) {
      try {
        const e = fromBinary(ErrorSchema, new Uint8Array(await resp.arrayBuffer()));
        if (e.code !== ErrorCode.UNSPECIFIED) code = e.code;
        if (e.message) message = e.message;
      } catch {
        // A body that is cut off or not an Error keeps the status-derived code.
      }
    }
    return new ApiError(code, message, resp.status, retryAfterMs);
  }

  private async body(resp: HttpResponse, what: string): Promise<Uint8Array> {
    try {
      return new Uint8Array(await resp.arrayBuffer());
    } catch (err) {
      throw new NetworkError(`${what}: response body interrupted`, err);
    }
  }

  private async decode<D extends DescMessage>(schema: D, resp: HttpResponse, what: string): Promise<MessageShape<D>> {
    const b = await this.body(resp, what);
    try {
      return fromBinary(schema, b);
    } catch (err) {
      throw new NetworkError(`${what}: malformed response`, err);
    }
  }

  private vaultPath(vaultId: string, rest: string): string {
    if (!/^[0-9a-f]{32}$/.test(vaultId)) throw new Error(`bad vault id ${vaultId}`);
    return `/v1/vaults/${vaultId}${rest}`;
  }

  // ---------- accounts and devices ----------

  async login(username: string, password: string, deviceName: string, platform: string): Promise<LoginResult> {
    checkPassword(password);
    const body = toBinary(LoginRequestSchema, create(LoginRequestSchema, { username, password, deviceName, platform }));
    const r = await this.decode(LoginResponseSchema, await this.send('POST', '/v1/auth/login', { body, auth: false }), 'login');
    this.token = r.token;
    return { token: r.token, deviceId: r.deviceId, userId: r.userId };
  }

  async logout(): Promise<void> {
    await this.send('POST', '/v1/auth/logout');
  }

  async listDevices(): Promise<DeviceInfo[]> {
    const r = await this.decode(ListDevicesResponseSchema, await this.send('GET', '/v1/devices'), 'devices');
    return r.devices.map((d) => ({
      deviceId: d.deviceId, name: d.name, platform: d.platform, createdAtMs: Number(d.createdAtMs),
      lastSeenAtMs: Number(d.lastSeenAtMs), current: d.current, revoked: d.revoked,
    }));
  }

  async revokeDevice(deviceId: string): Promise<void> {
    if (!/^[0-9a-f]{32}$/.test(deviceId)) throw new Error(`bad device id ${deviceId}`);
    await this.send('DELETE', `/v1/devices/${deviceId}`);
  }

  // ---------- key bundle ----------

  /** The stored bundle, or null before first-time setup. */
  async getKeyBundle(): Promise<KeyBundleFields | null> {
    let resp: HttpResponse;
    try {
      resp = await this.send('GET', '/v1/keys');
    } catch (err) {
      if (err instanceof ApiError && err.code === ErrorCode.NOT_FOUND) return null;
      throw err;
    }
    const kb = await this.decode(KeyBundleSchema, resp, 'keys');
    const p = kb.passParams;
    return {
      publicEncKey: kb.publicEncKey, publicSignKey: kb.publicSignKey, passSalt: kb.passSalt,
      passParams: { memoryKib: p?.memoryKib ?? 0, iterations: p?.iterations ?? 0, parallelism: p?.parallelism ?? 0 },
      passWrapped: kb.passWrapped, recoveryWrapped: kb.recoveryWrapped,
    };
  }

  /**
   * Uploads the bundle. The first upload, or re-sending the stored bundle,
   * needs no password; replacing it needs the account (login) password,
   * else WRONG_PASSWORD (403).
   */
  async putKeyBundle(kb: KeyBundleFields, currentPassword = ''): Promise<void> {
    checkPassword(currentPassword);
    const body = toBinary(KeyBundleSchema, create(KeyBundleSchema, {
      publicEncKey: kb.publicEncKey, publicSignKey: kb.publicSignKey, passSalt: kb.passSalt,
      passParams: { memoryKib: kb.passParams.memoryKib, iterations: kb.passParams.iterations, parallelism: kb.passParams.parallelism },
      passWrapped: kb.passWrapped, recoveryWrapped: kb.recoveryWrapped, currentPassword,
    }));
    await this.send('PUT', '/v1/keys', { body });
  }

  // ---------- vaults ----------

  async listVaults(): Promise<VaultInfo[]> {
    const r = await this.decode(ListVaultsResponseSchema, await this.send('GET', '/v1/vaults'), 'vaults');
    return r.vaults.map(vaultFromProto);
  }

  async createVault(vaultId: string, encName: Uint8Array, keys: SealedVaultKey[]): Promise<VaultInfo> {
    const body = toBinary(CreateVaultRequestSchema, create(CreateVaultRequestSchema, { vaultId, encName, keys }));
    return vaultFromProto(await this.decode(VaultSchema, await this.send('POST', '/v1/vaults', { body }), 'create vault'));
  }

  async vaultKeys(vaultId: string): Promise<SealedVaultKey[]> {
    const r = await this.decode(VaultKeysResponseSchema, await this.send('GET', this.vaultPath(vaultId, '/keys')), 'vault keys');
    return r.keys.map((k) => ({ epoch: k.epoch, sealedKey: k.sealedKey }));
  }

  // ---------- chunks ----------

  async chunksExist(vaultId: string, chunkIds: Uint8Array[]): Promise<boolean[]> {
    const body = toBinary(ChunkExistsRequestSchema, create(ChunkExistsRequestSchema, { chunkIds }));
    const r = await this.decode(ChunkExistsResponseSchema, await this.send('POST', this.vaultPath(vaultId, '/chunks/exists'), { body }), 'chunks exist');
    if (r.exists.length !== chunkIds.length) throw new NetworkError('chunks exist: wrong number of answers');
    return r.exists;
  }

  async putChunk(vaultId: string, chunkId: Uint8Array, sealed: Uint8Array): Promise<void> {
    await this.send('PUT', this.vaultPath(vaultId, `/chunks/${toHex(chunkId)}`), { body: sealed, contentType: OCTETS });
  }

  /** Downloads a chunk; a body shorter than Content-Length is a NetworkError, so the caller retries. */
  async getChunk(vaultId: string, chunkId: Uint8Array): Promise<Uint8Array> {
    const resp = await this.send('GET', this.vaultPath(vaultId, `/chunks/${toHex(chunkId)}`));
    const b = await this.body(resp, 'chunk');
    const declared = resp.headers.get('Content-Length');
    if (declared !== null && Number(declared) !== b.length) throw new NetworkError('chunk: truncated body');
    return b;
  }

  // ---------- change log ----------

  async commit(vaultId: string, commits: CommitInput[]): Promise<CommitReply> {
    if (commits.length === 0 || commits.length > MAX_COMMITS_PER_REQUEST) throw new RangeError(`send 1 to ${MAX_COMMITS_PER_REQUEST} commits`);
    const body = toBinary(CommitRequestSchema, create(CommitRequestSchema, {
      commits: commits.map((c) => ({ ...c, size: BigInt(c.size) })),
    }));
    const r = await this.decode(CommitResponseSchema, await this.send('POST', this.vaultPath(vaultId, '/commit'), { body }), 'commit');
    if (r.results.length !== commits.length) throw new NetworkError('commit: wrong number of results');
    return {
      vaultSeq: Number(r.vaultSeq),
      results: r.results.map((x) => ({
        fileId: x.fileId, ok: x.ok, seq: Number(x.seq), headVersionId: x.headVersionId,
        ...(x.error ? { error: { code: x.error.code, message: x.error.message } } : {}),
      })),
    };
  }

  async changes(vaultId: string, since: number, limit = CHANGES_PAGE_SIZE): Promise<ChangesPage> {
    const r = await this.decode(ChangesResponseSchema, await this.send('GET', this.vaultPath(vaultId, `/changes?since=${since}&limit=${limit}`)), 'changes');
    return { versions: r.versions.map(versionFromProto), vaultSeq: Number(r.vaultSeq), more: r.more };
  }

  async heads(vaultId: string, after: Uint8Array | null, limit = HEADS_PAGE_SIZE): Promise<HeadsPage> {
    const q = `?limit=${limit}` + (after ? `&after=${toHex(after)}` : '');
    const r = await this.decode(HeadsResponseSchema, await this.send('GET', this.vaultPath(vaultId, `/heads${q}`)), 'heads');
    return { heads: r.heads.map((x) => ({ fileId: x.fileId, versionId: x.versionId, seq: Number(x.seq), deleted: x.deleted })), more: r.more };
  }

  /** Every retained version of one file, newest first. */
  async history(vaultId: string, fileId: Uint8Array): Promise<RemoteVersion[]> {
    const r = await this.decode(VersionsResponseSchema, await this.send('GET', this.vaultPath(vaultId, `/files/${toHex(fileId)}/history`)), 'history');
    return r.versions.map(versionFromProto);
  }

  /** Tombstone heads of deleted files that can still be restored, newest first. */
  async trash(vaultId: string): Promise<RemoteVersion[]> {
    const r = await this.decode(VersionsResponseSchema, await this.send('GET', this.vaultPath(vaultId, '/trash')), 'trash');
    return r.versions.map(versionFromProto);
  }
}
