# Obsidian Sync: Architecture and Sub-project 1 Design

- **Date:** 2026-10-03
- **Status:** Draft, awaiting review
- **Scope of this document:** the overall architecture every sub-project builds on (sections 1–8), and the detailed scope of sub-project 1, core sync (section 9). Later sub-projects get their own spec → plan → implementation cycle.

## 1. Purpose

A self-hosted, free, end-to-end encrypted sync service for Obsidian vaults: a Go server (`obsync`) and an Obsidian plugin. Each client syncs its local vault folder with the server.

Why build it, when Obsidian Sync, Self-hosted LiveSync, Remotely Save and Syncthing exist:

- **Self-hosted and free.** Runs on the operator's own infrastructure.
- **Simpler than LiveSync.** No CouchDB. The default deployment is one container with one data volume.
- **End-to-end encrypted.** The server never sees note contents or file paths.

### 1.1 Users and scale

- Multi-tenant: many user accounts per instance, open to people other than the operator.
- Vaults can be **shared between users**.
- Target scale: thousands of users per instance and several server replicas. Single-node remains the default and the simplest mode.
- The plugin supports **desktop and mobile** (Windows, macOS, Linux, iOS, Android).

### 1.2 Success criteria

- Edits on one device appear on the user's other online devices within a few seconds.
- Concurrent edits never silently lose data. They are merged automatically, or they produce a visible conflict copy.
- An operator with full access to the server and database cannot read note contents, file names or folder names.
- A single-node instance is deployable with one `docker compose up` and one volume to back up.
- The convergence suite (section 8) passes: after random concurrent operations, every client's vault is identical.

## 2. Decisions (summary)

| Topic | Decision |
|---|---|
| Sync model | v1: near-real-time file sync, 3-way merge on the client, conflict copies. v2: live co-editing (Yjs) layered on top. |
| Protocol core | Server-ordered change log per vault, monotonic `seq`, optimistic concurrency on `base_version` (approach A). |
| Server | Go, single binary `obsync` with subcommands `serve`, `admin` and `migrate`. |
| Wire format | Protobuf (schema in `proto/`, Go and TS generated with `buf`). Chunk bytes go over plain HTTP. |
| Metadata DB | libSQL: local embedded file (default), self-hosted `sqld`, or Turso Cloud, using a direct primary connection. Same model as the sibling project budget-manager. Embedded-replica mode is not supported. |
| Blob storage | Local disk (default) or S3-compatible (MinIO, R2, B2…). |
| Cross-replica bus | In-memory (single node) or NATS (clustered). |
| Auth | Username/email + password, OIDC, TOTP, per-device revocable tokens. |
| E2EE | Separate encryption passphrase plus a one-time recovery key. Paths are encrypted too. |
| Sharing | Yes. Vault keys are sealed to each member's public key, and a new epoch key is created when a member is removed. |
| Synced content | Notes and attachments; `.obsidian/` settings and community plugins as a **personal** layer (the user's own devices only); per-device exclusions. |
| Plugin code sync | Incoming plugin code is staged until approved on each device. The sync plugin itself is never synced. |
| History | Per-file version history plus restorable trash. Retention is configured by the admin and counts against quota. |
| Admin | Quotas, web admin UI (Go templates + htmx), admin CLI, health checks and Prometheus metrics. |
| TLS | Not built in. Runs behind a reverse proxy (the example compose file ships Caddy). The plugin requires HTTPS except on `localhost`. |
| Shipping | Multi-arch Docker image, compose examples, Helm chart, Linux/macOS release binaries, systemd unit. |

## 3. Roadmap (sub-projects)

Each sub-project gets its own spec → plan → implementation cycle, in this order:

1. **Core sync.** One user, an encrypted vault, multiple devices, history and trash, single-node deployment. This is the minimum usable product. Detailed in section 9.
2. **Accounts and auth.** OIDC, TOTP, device management UI, registration modes (open, invite-only, admin-created).
3. **Sharing.** Inviting members, sealing keys to members, rotating the epoch key when a member is removed, pinning members' public keys and showing fingerprints.
4. **Config and plugin sync.** The personal `.obsidian/` layer, staging and approving plugin code, per-device selective sync.
5. **Admin and operations.** Web admin UI, quota management, metrics, clustered mode (sqld/Turso + S3 + NATS), Helm chart.
6. **(v2) Live co-editing.** Encrypted Yjs updates relayed through the server, CodeMirror integration, cursor presence.

Every decision in sections 4–7 applies to all sub-projects, even where a sub-project builds only part of it.

## 4. Components and repository layout

```
obsidian-sync/
  proto/      Protobuf schema → generated Go + TS (buf)
  server/     Go module: cmd/obsync, internal/...
  plugin/     TypeScript Obsidian plugin (esbuild)
  deploy/     compose files, Helm chart, systemd unit
  docs/
```

### 4.1 Server components

Each component sits behind an interface so it can be tested and swapped on its own.

- **API:** HTTP endpoints for auth, vault management, chunk upload and download (`HEAD`/`PUT`/`GET`), and admin.
- **Hub:** one WebSocket per device. It sends `Notify{vault, seq}` and multiplexes messages by channel type, so v2 live sessions can be added as a new channel type.
- **Sync service:** the change log, commit validation (`base_version`), history and trash, quota checks.
- **Auth service:** passwords (argon2id), OIDC, TOTP, device tokens.
- **Storage interfaces:**
  - `MetaStore` (libSQL: local file, sqld or Turso)
  - `BlobStore` (local disk or S3)
  - `Bus` (in-memory or NATS)
- **Admin UI:** server-rendered Go templates + htmx, embedded in the binary.
- **Jobs:** retention pruning and chunk garbage collection. Each job runs under a lease row in the database.

### 4.2 Plugin components

- **Crypto:** WebCrypto for AES-GCM and HKDF. `@noble/curves` and `@noble/hashes` for X25519, Ed25519 and Argon2id, because WebCrypto X25519 support in mobile WebViews is not reliable. No Node APIs, since the plugin must run on mobile.
- **Watcher:** Obsidian vault events, plus polling of the adapter for paths vault events don't report (`.obsidian/`, used from sub-project 4).
- **Local state (IndexedDB):**
  - mapping from `file_id` to path
  - last synced `version_id` per file
  - base text for 3-way merges
  - the sync cursor per vault
  - the offline push queue
  - the device's unlocked keys
- **Sync engine:** pull and push queues, merging, conflict copies, retries with backoff.
- **UI:**
  - settings tab
  - status-bar indicator
  - history and trash view with diff and restore
  - conflict notices
  - (sub-project 4) plugin approval dialog

## 5. Data model and sync protocol

### 5.1 File identity

- `file_id = HMAC-SHA256(naming_key, NFC(path))`, where `path` is vault-relative with `/` separators.
- The server enforces one row per `(vault_id, file_id)`. Two devices creating the same path at the same time therefore contend on one file, and the normal conflict flow handles it.
- **A rename is a tombstone on the old `file_id` plus a create on the new `file_id`.** The create reuses the same chunk IDs, so nothing is uploaded again. The new version's encrypted metadata carries `renamed_from` (the old path) so the history view can follow a file across renames.
- On a case-insensitive file system, two paths that differ only in case are detected by the plugin. The incoming one is written as a conflict copy.

### 5.2 Versions and chunks

A **version** is `{version_id, file_id, epoch, enc_meta, chunk_ids[], size, deleted, device_id, created_at, seq}`.

- `version_id` is a random 128-bit ID created by the client, so it can be part of the AAD.
- `enc_meta` decrypts to `{path, mtime, size, content_hash, renamed_from?}`.
- Content is split into **4 MiB plaintext chunks**. Each chunk is encrypted separately and stored under `chunk_id = HMAC-SHA256(chunk_id_key[epoch], plaintext)`.
  - Duplicates are detected only within a vault and epoch.
  - The server sees only chunk IDs and ciphertext sizes.
  - An empty file has an empty chunk list.
- Tables (sketch):
  - `vaults(id, owner_id, seq, current_epoch, …)`
  - `files(vault_id, file_id, head_version_id)`
  - `versions(…)`
  - `version_chunks(version_id, idx, chunk_id)`
  - `chunks(vault_id, chunk_id, size, created_at)`
  - `vault_keys(vault_id, user_id, epoch, sealed_key)`

### 5.3 Push

1. The client asks the server which chunks it already has (`HEAD /v/{vault}/chunks/{id}`, or a batched existence check) and `PUT`s the missing ones.
2. The client sends `Commit{file_id, base_version_id (empty = new file), version_id, epoch, enc_meta, chunk_ids, size, deleted}`. Several commits can go in one request.
3. For each commit, in one transaction, the server:
   - checks that `files.head_version_id == base_version_id`
   - checks that every referenced chunk exists and the quota allows the new bytes
   - increments `vaults.seq`
   - inserts the version and moves the head

   On a mismatch the server returns `Conflict{head_version_id}` for that commit only. Each commit succeeds or fails independently.
4. After it commits, the server publishes `Notify{vault, seq}` on the bus.

### 5.4 Pull

1. When a `Notify` arrives with a `seq` above the local cursor (or on connect), the client requests `Changes{vault, since: cursor, limit}`. Pages are ordered by `seq`.
2. For each change, the client fetches any chunks it is missing, decrypts and verifies them (AAD plus `content_hash`), applies the change following section 5.5, then saves the cursor.

### 5.5 Applying remote changes and merging

For each incoming version of a `file_id`:

| Local state since last synced version | Action |
|---|---|
| Unchanged | Overwrite or delete locally. Update the base. |
| Changed, and the file is text (`.md`, `.txt`, `.canvas`, `.json`, `.css`…) | 3-way merge (diff3) of base, local and remote. If clean, write it and push with `base = remote head`. |
| Changed, and the merge has overlapping hunks, or the file is binary | Keep the local file at its path. Write the remote version to `name (conflict <device> <YYYY-MM-DD HHmm>).ext`. Show a notice. Push the local version with `base = remote head`. |
| Local edit vs remote delete, or local delete vs remote edit | **The edit wins.** The file is restored or kept. |

When a push gets a `Conflict` response, the client pulls the new head and then applies the same table.

Line endings are normalized for comparison only. Files are written back with their original line endings.

### 5.6 Reconcile

On startup, after a reconnect, and every 15 minutes, the client requests `Heads{vault}` (a `file_id → head_version_id` list, paged) and compares it with local state and with a scan of the local file system:

- unseen remote heads are pulled
- local files with no `file_id` record are pushed as creates
- local records whose file has disappeared are pushed as deletes

This is a safety net that catches events missed while offline, during crashes, or from edits made outside Obsidian.

### 5.7 History, trash and garbage collection

- Earlier versions are kept as rows. A deleted file's head is a tombstone version, and the file stays in the trash until retention expires.
- Retention policy is set per instance by the admin (for example 30 days and/or the last N versions per file, plus a separate trash period).
- **Pruning job:** removes versions outside retention. It never removes a head that isn't a tombstone.
- **Chunk GC job:** mark and sweep over `version_chunks`. A chunk is deleted only if nothing references it and it is older than a grace period (default 24 h). This protects chunks that were uploaded but not yet committed.
- Both jobs take an expiring lease row in the `job_leases` table, so in clustered mode only one replica runs each job.

## 6. Encryption and keys

### 6.1 Threat model

- **Confidentiality.** The server, its operator, or an attacker with full server and database access cannot read contents, paths, file names or folder names.
- **Visible to the server:**
  - sizes, timestamps, number of files and versions, chunk deduplication within an epoch
  - vault membership, devices and IP addresses
- **Integrity.** Every encrypted object is authenticated and bound to its location through AAD, so the server cannot move ciphertext between files, vaults or epochs.
- **Out of scope.** A malicious server can withhold data, roll back to old versions, or deny service. That's detectable in some cases but not prevented.

### 6.2 User keys

- Each user generates an X25519 keypair (encryption) and an Ed25519 keypair (signing) on their first device.
- The private keys are stored on the server as two encrypted bundles:
  - `KEK_pass = Argon2id(passphrase, salt, params)`. Params are stored per user so they can be raised later. The default target is about 1 s on a mid-range phone.
  - `KEK_recovery = HKDF(recovery_key)`, where `recovery_key` is 256 random bits shown once as a word list.
- The **encryption passphrase is separate from the login password**, because OIDC users have no password the plugin sees.
- A device needs the passphrase or recovery key only when it is first added. After that, unlocked keys stay in the plugin's local storage. That's equivalent in risk to the unencrypted vault already sitting on that device's disk.
- Changing the passphrase re-encrypts the private-key bundle only.

### 6.3 Vault keys

- **Naming key:** 256 random bits, fixed for the vault's lifetime. It's used only for `file_id`. It never rotates, because rotating it would change every file ID.
- **Epoch keys** `K_e` (e = 1, 2, …) are 256 random bits. Keys are derived from each one with HKDF-SHA256 using these labels:
  - `content_key[e]`
  - `meta_key[e]`
  - `chunk_id_key[e]`
- **Sealing:** the naming key and every epoch key are sealed to each member's X25519 public key. Sealing uses an ephemeral X25519 key, ECDH, HKDF, then AES-256-GCM, and the result is stored in `vault_keys`.

### 6.4 Object encryption

- Encryption is AES-256-GCM with a random 96-bit nonce, stored as a prefix on the ciphertext.
- AAD for a chunk: `"chunk" ‖ vault_id ‖ epoch ‖ chunk_id`.
- AAD for metadata: `"meta" ‖ vault_id ‖ file_id ‖ version_id`.
- After decryption the plugin also checks that the reassembled content matches `content_hash` (SHA-256).

### 6.5 Membership changes (sub-project 3)

- **Adding a member:** an existing member seals the naming key and all epoch keys to the new member's pinned public key.
- **Removing a member:**
  1. The remover creates `K_{e+1}` and seals it, along with the naming key, to the remaining members only.
  2. The vault's `current_epoch` moves forward.
  3. The server rejects commits that use a stale epoch (`STALE_EPOCH`).
  4. Earlier epochs stay readable to current members, so history keeps working. **History is not re-encrypted**, since the removed member could already read it.
- **Known limit:** a removed member still has the naming key, so they could confirm whether a *guessed* path exists. They cannot read anything written after their removal.
- **Key pinning:** the plugin pins each member's public key the first time it sees it, and shows a short fingerprint that can be compared out-of-band. A changed key raises a warning.

### 6.6 Device tokens (sub-project 1 minimal, sub-project 2 complete)

- After login, the device receives an opaque random bearer token. The server stores only its SHA-256 hash, along with the device name, platform, creation time and last-seen time.
- Tokens can be revoked one at a time. A revoked token gets `DEVICE_REVOKED`, and the plugin stops syncing and tells the user.

## 7. Deployment and operations

### 7.1 Configuration

- Settings come from `OBSYNC_*` environment variables, or from an optional YAML file that the variables override.
- Config is validated at startup. Invalid combinations **stop the server from starting**:
  - `cluster: true` with a local libSQL file or the local-disk `BlobStore`
  - `cluster: true` without a NATS URL
  - an S3 configuration that is missing fields

### 7.2 Single-node mode (default)

- Local libSQL file `/data/meta.db`, blobs in `/data/blobs`, in-memory bus.
- Migrations run automatically on startup.
- One volume to back up.

### 7.3 Clustered mode (sub-project 5)

- libSQL on `sqld` or Turso Cloud through a direct primary connection, blobs in S3, NATS as the bus.
- No sticky sessions. Each replica subscribes to `obsync.vault.<id>` only for the vaults followed by devices connected to it.
- `seq` is assigned inside a database transaction on the single libSQL writer, so it has no gaps or duplicates across replicas. Commits are batched per request to reduce round-trips.
- Migrations run through `obsync migrate`, executed as a Helm pre-upgrade job.

### 7.4 Limits and quotas

- Per-user storage quota covering unique chunk bytes plus kept history. **Shared vaults count against the owner's quota.**
- Maximum file size is configurable (default 2 GiB).
- Per-device rate limiting with an in-memory token bucket on each replica (approximate when clustered).

### 7.5 Errors

- Protobuf defines typed error codes: `CONFLICT`, `QUOTA_EXCEEDED`, `UNAUTHORIZED`, `DEVICE_REVOKED`, `STALE_EPOCH`, `RATE_LIMITED`, `TOO_LARGE`, `NOT_FOUND`, `INTERNAL`.
- The plugin retries temporary failures with exponential backoff and jitter, and reconnects the WebSocket the same way. The offline queue lives in IndexedDB and survives restarts.
- The status bar shows the sync state (synced, syncing, offline, error).
- Errors that need the user to act (`QUOTA_EXCEEDED`, `DEVICE_REVOKED`, passphrase required, `TOO_LARGE`) show a persistent notice.

### 7.6 Observability

- `/healthz` (liveness) and `/readyz` (database, blob store and bus reachable).
- Prometheus `/metrics` on a separate, configurable port.
- Structured JSON logs (`log/slog`).
- **Tokens, keys, passphrases and encrypted payloads are never logged.**

### 7.7 Shipping

- Multi-arch Docker image (linux/amd64, linux/arm64).
- Release binaries for Linux and macOS. The libSQL Go driver needs CGO and has no Windows build, so Windows hosts use Docker.
- `deploy/compose/`:
  - `single-node` (obsync + Caddy for automatic HTTPS)
  - `clustered` (2× obsync + sqld + MinIO + NATS + Caddy as the load balancer)
- Helm chart that requires clustered values when `replicas > 1`.
- systemd unit example.

## 8. Testing strategy

- **Server unit and integration tests** run against a real local libSQL file in a temporary directory. They are hermetic and need no network.
- **Backend contract suites:** one suite per interface (`MetaStore`, `BlobStore`, `Bus`), run against every implementation.
  - The local and in-memory implementations always run.
  - sqld, MinIO and NATS run through testcontainers, opt-in locally and always in CI.
- **Concurrency tests:**
  - racing commits on the same `file_id` produce exactly one winner, and every loser gets `CONFLICT`
  - `seq` has no gaps or duplicates under concurrent commits
- **Plugin tests (vitest):**
  - known-answer tests for key derivation, sealing, chunk and metadata encryption and `file_id`, with test vectors checked into `plugin/test/vectors/`
  - a table of diff3 merge cases (overlapping, adjacent, frontmatter, line endings, empty files)
  - sync engine tests against a fake vault adapter and a fake server
- **End-to-end convergence suite:**
  - starts the real `obsync` server, then N simulated clients running the actual plugin sync engine in Node on an in-memory vault adapter
  - clients perform random operations from a fixed seed: create, edit, rename, delete, offline, reconnect, concurrent edits to the same file
  - asserts that every client's vault is byte-identical and that no edit was lost except into a documented conflict copy
  - a failing seed can be replayed exactly
- **Manual release checklist** in real Obsidian, desktop and mobile:
  - first setup
  - adding a second device
  - a conflict
  - recovery-key unlock
  - (from sub-project 4) plugin approval
- **CI (GitHub Actions):**
  - Go: `go test`, `go vet`, `golangci-lint`
  - plugin: lint, test, build
  - protocol: `buf lint` and `buf breaking`
  - the convergence suite
  - multi-arch Docker build

## 9. Sub-project 1: core sync (detailed scope)

### 9.1 In scope

- **Protocol:** the Protobuf schema for everything in section 5, plus a minimal auth and vault API.
- **Server:**
  - `obsync serve` and `obsync migrate`
  - `obsync admin user create|list|delete|set-password` (the only way to create accounts in this sub-project)
  - `MetaStore` on a local libSQL file
  - `BlobStore` on local disk
  - in-memory `Bus`
  - sync service, Hub, pruning and chunk GC jobs
  - `/healthz` and `/readyz`
  - config validation
- **Auth (minimal):**
  - username + password login (argon2id hashes)
  - per-device tokens
  - a `GET/DELETE /devices` API to list and revoke devices (no UI beyond the plugin settings tab)
- **Crypto:**
  - the user keypair, passphrase bundle and recovery-key bundle
  - vault naming key and epoch 1, sealed to the owner only
  - all object encryption in section 6.4
- **Plugin:**
  - settings tab: server URL (HTTPS required except `localhost`), login, first-time key setup with the recovery-key display, passphrase unlock on new devices, choosing or creating a remote vault
  - watcher, IndexedDB local state, sync engine (push, pull, merge, conflict copies, reconcile, offline queue)
  - status bar
  - history and trash view with diff and restore
  - device list with revoke
- **Synced content:** all vault files except `.obsidian/`, plus a fixed default ignore list (`.trash/`, `.git/`, OS junk files). User-editable ignore globs, stored per device.
- **Quotas:** enforced per user, using a default limit from config. There is no management UI yet.
- **Deployment:**
  - Dockerfile and multi-arch image
  - `deploy/compose/single-node` with Caddy
  - Linux/macOS release binaries
  - systemd unit
- **Tests:** everything in section 8 that applies to the components above, including the convergence suite.

### 9.2 Out of scope (deferred to later sub-projects)

| Deferred item | Sub-project |
|---|---|
| OIDC, TOTP, registration modes, device management UI | 2 |
| Sharing, membership, epoch rotation, key pinning | 3 |
| `.obsidian/` sync, plugin code approval, selective sync | 4 |
| Web admin UI, quota management, Prometheus metrics, sqld/Turso, S3, NATS, clustering, Helm chart | 5 |
| Live co-editing | 6 (v2) |

Every schema and protocol message for sub-project 1 still includes the fields later sub-projects need (`epoch`, `vault_keys` per user, channel-tagged WebSocket messages), so those features can be added without a breaking protocol change.

### 9.3 Done when

- Two desktop devices and one mobile device on the same account keep a vault in sync, with changes visible within 5 s while online.
- The convergence suite passes 1,000 random seeds in CI.
- Inspecting the server's database and blob directory shows no plaintext file content, file names or folder names.
- A new device can be set up with the recovery key instead of the passphrase.
- A deleted file can be restored from the trash, and an earlier version can be restored from history.

## 10. Risks and open items

- **Pure-JS Argon2id on mobile is slow.** The parameters are tuned to about 1 s on a mid-range phone and stored per user so they can be raised later. If that proves too slow, a WASM build of Argon2 is a drop-in fallback.
- **Mobile background limits.** On iOS and Android, sync runs only while Obsidian is in the foreground. This is documented, and reconcile on resume covers the gap.
- **Edits made outside Obsidian** while it is closed (for example with git or another editor) are picked up only by reconcile on the next start. That's acceptable.
- **libSQL driver.** `go-libsql` (CGO) is used for local-file mode. Before the plan is written, check that it supports a direct remote primary connection for sub-project 5. If not, plan a remote-only client for clustered mode behind the same `MetaStore` interface.
- **Single libSQL writer** limits commit throughput at very large scale. Commits are batched to reduce this. Revisit only if load testing in sub-project 5 shows a real bottleneck.
