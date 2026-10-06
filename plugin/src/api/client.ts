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
import { ApiError, NetworkError, TruncatedBodyError } from './errors';
import { RateGate } from './gate';
import { toSafeNumber } from '../util/int';
import {
  CHANGES_PAGE_SIZE, COMMIT_BODY_LIMIT, HEADS_PAGE_SIZE, LOGIN_BODY_LIMIT, MAX_CHUNK_EXISTS_BATCH, MAX_COMMITS_PER_REQUEST, MAX_PASSWORD_BYTES,
} from './limits';
import type {
  ChangesPage, CommitInput, CommitReply, DeviceInfo, HeadsPage, KeyBundleFields, LoginResult, RemoteVersion,
  SealedVaultKey, VaultInfo,
} from './types';

export const PROTO = 'application/x-protobuf';
export const OCTETS = 'application/octet-stream';

/**
 * The HTTP transport. The Obsidian plugin supplies one over requestUrl (no
 * CORS preflight); a host without it registers one with setDefaultTransport
 * (the test suite registers fetch). Only whole,
 * buffered bodies are used: no streaming, no AbortSignal, no cookies.
 */
export interface HttpRequest {
  method: string;
  /** Header names as written here; a transport may lower-case them. */
  headers: Record<string, string>;
  /**
   * May be a view into a larger buffer (byteOffset > 0 or a shorter
   * byteLength). A transport that takes an ArrayBuffer, like Obsidian's
   * requestUrl, must send body.buffer.slice(byteOffset, byteOffset + byteLength),
   * never body.buffer itself.
   */
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

const noTransport: FetchLike = () => Promise.reject(new TypeError('no HTTP transport is configured'));
let defaultTransport: FetchLike | null = null;

/** The transport ApiClients use when not given one (null: none, and requests fail as if offline). */
export function setDefaultTransport(transport: FetchLike | null): void {
  defaultTransport = transport;
}

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

/**
 * The code for an error that did not come with a protobuf Error body (a
 * proxy, load balancer or captive portal answered). Only 413 and 429 mean
 * the same thing everywhere; anything else is treated as a transient
 * server-side failure, never as UNAUTHORIZED, NOT_FOUND and the like,
 * which would stop sync or claim the account has no key bundle.
 */
function statusCode(status: number): ErrorCode {
  switch (status) {
    case 413: return ErrorCode.TOO_LARGE;
    case 429: return ErrorCode.RATE_LIMITED;
    default: return ErrorCode.INTERNAL;
  }
}

/** A 64-bit field as a number; a value beyond 2^53 - 1 is a malformed response. */
function num(v: bigint, what: string): number {
  try {
    return toSafeNumber(v, what);
  } catch (err) {
    throw new NetworkError(`malformed response: ${(err as Error).message}`, err);
  }
}

function versionFromProto(v: Version): RemoteVersion {
  return {
    fileId: v.fileId, versionId: v.versionId, baseVersionId: v.baseVersionId, epoch: v.epoch, encMeta: v.encMeta,
    chunkIds: v.chunkIds, size: num(v.size, 'size'), deleted: v.deleted, deviceId: v.deviceId,
    createdAtMs: num(v.createdAtMs, 'created_at_ms'), seq: num(v.seq, 'seq'),
  };
}

function vaultFromProto(v: Vault): VaultInfo {
  return {
    vaultId: v.vaultId, encName: v.encName, currentEpoch: v.currentEpoch, seq: num(v.seq, 'seq'),
    createdAtMs: num(v.createdAtMs, 'created_at_ms'), ownerId: v.ownerId,
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
    this.fetchFn = opts.fetch ?? defaultTransport ?? noTransport;
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
    // Always read the body, so the connection is released.
    const body = await resp.arrayBuffer().catch(() => null);
    // Only a protobuf Error with a code is the obsync server speaking; a
    // body that is cut off, empty or something else keeps the status-derived code.
    if (body !== null && (resp.headers.get('Content-Type') ?? '').startsWith(PROTO)) {
      try {
        const e = fromBinary(ErrorSchema, new Uint8Array(body));
        if (e.code !== ErrorCode.UNSPECIFIED) {
          code = e.code;
          if (e.message) message = e.message;
        }
      } catch {
        // not an Error
      }
    }
    return new ApiError(code, message, resp.status, retryAfterMs);
  }

  private async body(resp: HttpResponse, what: string): Promise<Uint8Array> {
    try {
      return new Uint8Array(await resp.arrayBuffer());
    } catch (err) {
      throw new TruncatedBodyError(`${what}: response body interrupted`, err);
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
    if (body.length > LOGIN_BODY_LIMIT) throw new ApiError(ErrorCode.INVALID, `the login request is over ${LOGIN_BODY_LIMIT} bytes`, 0);
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
      deviceId: d.deviceId, name: d.name, platform: d.platform, createdAtMs: num(d.createdAtMs, 'created_at_ms'),
      lastSeenAtMs: num(d.lastSeenAtMs, 'last_seen_at_ms'), current: d.current, revoked: d.revoked,
    }));
  }

  async revokeDevice(deviceId: string): Promise<void> {
    if (!/^[0-9a-f]{32}$/.test(deviceId)) throw new Error(`bad device id ${deviceId}`);
    await this.send('DELETE', `/v1/devices/${deviceId}`);
  }

  // ---------- key bundle ----------

  /** The stored bundle, or null before first-time setup (a protobuf NOT_FOUND from the server, not any 404). */
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
    if (chunkIds.length > MAX_CHUNK_EXISTS_BATCH) throw new RangeError(`ask about at most ${MAX_CHUNK_EXISTS_BATCH} chunks at a time`);
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
    // Content-Length counts encoded bytes: with a Content-Encoding (a proxy
    // compressing) the decoded body is longer, so only a plain one is checked.
    const declared = resp.headers.get('Content-Length')?.trim() ?? null;
    if (declared !== null && /^\d+$/.test(declared) && resp.headers.get('Content-Encoding') === null && Number(declared) !== b.length) {
      throw new TruncatedBodyError('chunk: truncated body');
    }
    return b;
  }

  // ---------- change log ----------

  async commit(vaultId: string, commits: CommitInput[]): Promise<CommitReply> {
    if (commits.length === 0 || commits.length > MAX_COMMITS_PER_REQUEST) throw new RangeError(`send 1 to ${MAX_COMMITS_PER_REQUEST} commits`);
    const body = toBinary(CommitRequestSchema, create(CommitRequestSchema, {
      commits: commits.map((c) => ({ ...c, size: BigInt(c.size) })),
    }));
    if (body.length > COMMIT_BODY_LIMIT) throw new RangeError(`commit request is ${body.length} bytes, over the ${COMMIT_BODY_LIMIT}-byte limit`);
    const r = await this.decode(CommitResponseSchema, await this.send('POST', this.vaultPath(vaultId, '/commit'), { body }), 'commit');
    if (r.results.length !== commits.length) throw new NetworkError('commit: wrong number of results');
    return {
      vaultSeq: num(r.vaultSeq, 'vault_seq'),
      results: r.results.map((x) => ({
        fileId: x.fileId, ok: x.ok, seq: num(x.seq, 'seq'), headVersionId: x.headVersionId,
        ...(x.error ? { error: { code: x.error.code, message: x.error.message } } : {}),
      })),
    };
  }

  async changes(vaultId: string, since: number, limit = CHANGES_PAGE_SIZE): Promise<ChangesPage> {
    const r = await this.decode(ChangesResponseSchema, await this.send('GET', this.vaultPath(vaultId, `/changes?since=${since}&limit=${limit}`)), 'changes');
    return { versions: r.versions.map(versionFromProto), vaultSeq: num(r.vaultSeq, 'vault_seq'), more: r.more };
  }

  async heads(vaultId: string, after: Uint8Array | null, limit = HEADS_PAGE_SIZE): Promise<HeadsPage> {
    const q = `?limit=${limit}` + (after ? `&after=${toHex(after)}` : '');
    const r = await this.decode(HeadsResponseSchema, await this.send('GET', this.vaultPath(vaultId, `/heads${q}`)), 'heads');
    return { heads: r.heads.map((x) => ({ fileId: x.fileId, versionId: x.versionId, seq: num(x.seq, 'seq'), deleted: x.deleted })), more: r.more };
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
