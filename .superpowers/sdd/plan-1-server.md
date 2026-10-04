# Core Sync, Plan 1 of 3: Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `obsync` Go server for sub-project 1 (core sync): accounts with device tokens, E2EE key-bundle storage, vaults, encrypted chunk storage, the per-vault change log with optimistic concurrency, a WebSocket push hub, history/trash retention with chunk garbage collection, and the `serve` / `migrate` / `admin` CLI.

**Architecture:** One Go module in `server/`. Every request and response body is Protobuf, generated with `buf` from `proto/obsync/v1/obsync.proto`. `internal/store` owns all SQL against libSQL. Feature packages (`auth`, `syncsvc`, `hub`, `jobs`, `admin`) depend on small interfaces they declare themselves. `internal/api` holds thin HTTP handlers. `internal/app` wires everything together. The server never decrypts anything. It stores opaque bytes and enforces ordering, membership, size and quota.

**Tech Stack:** Go 1.23, `github.com/tursodatabase/go-libsql` (CGO), `google.golang.org/protobuf` + `buf`, `github.com/coder/websocket`, `golang.org/x/crypto/argon2`, `gopkg.in/yaml.v3`, `golang.org/x/term`.

**Spec:** `.superpowers/sdd/spec.md` (sections 4.1, 5, 6.6, 7, 8, 9).

**Where this plan sits:** sub-project 1 has three plans, and each produces software that can be tested on its own:
1. **This plan: the server**, tested with Go unit, integration and HTTP/WebSocket end-to-end tests.
2. **Plugin engine:** TS protocol types, crypto (with known-answer vectors), IndexedDB state, sync engine, 3-way merge, and the convergence suite running simulated clients against this server.
3. **Obsidian integration and packaging:** plugin UI (settings, status bar, history/trash view, device list), Dockerfile + multi-arch image, `deploy/compose/single-node` with Caddy, release binaries, systemd unit, CI workflows.

**Decisions this plan makes inside the spec's latitude** (the spec already allows each of them; they're listed so a reviewer isn't surprised):
- **Quota is checked when a chunk is uploaded, not at commit.** Chunks are the only thing that use space, so checking at upload enforces the same limit, earlier.
- **Two error codes beyond the spec's list:** `ERROR_CODE_INVALID` for malformed input, and `ERROR_CODE_MISSING_CHUNK` for a commit that references a chunk the server doesn't have, so the client knows to upload it again.
- **Retried commits are idempotent.** Committing a `version_id` that is already stored for the same file returns its original `seq` instead of a conflict, so a commit whose response was lost can safely be sent again.
- **WebSocket authentication uses a first `Auth` frame**, not a header, because the browser WebSocket API used by Obsidian can't set headers. The token never goes in a URL.
- **Vault names are encrypted too** (`enc_name`). The server treats them as opaque bytes, and plan 2 defines how the plugin encrypts them.
- **Clustered mode and S3 are rejected at startup** with a clear "not available yet" message (they arrive in sub-project 5).
- **Login attempts are rate-limited per username.** General per-device request rate limiting arrives with sub-project 5.

## Global Constraints

- Go toolchain **1.23** (`go 1.23` in `go.mod`). Set `GOTOOLCHAIN=local` so Go never downloads another toolchain.
- **`CGO_ENABLED=1`** for every build and test (go-libsql is CGO). Supported server platforms are linux/amd64, linux/arm64, darwin/amd64 and darwin/arm64.
- Module path: **`github.com/jfms7s/obsidian-sync/server`**.
- Pinned dependency versions:
  - `google.golang.org/protobuf@v1.35.2`
  - `github.com/bufbuild/buf/cmd/buf@v1.47.2`
  - `google.golang.org/protobuf/cmd/protoc-gen-go@v1.35.2`
  - `gopkg.in/yaml.v3@v3.0.1`
  - `github.com/tursodatabase/go-libsql@v0.0.0-20260424063416-3051e37e6e04`
  - `golang.org/x/crypto@v0.31.0`
  - `github.com/coder/websocket@v1.8.12`
  - `golang.org/x/term@v0.27.0`
- **go-libsql facts, verified on this machine 2026-10-03:**
  - `Exec` runs **only the first statement** of a multi-statement string and ignores the rest.
  - A `nil` `[]byte` argument is stored as an empty blob, not `NULL`.
  - `PRAGMA journal_mode=WAL` returns a row, so run it with `QueryRow`.
  - Unique violations come back as an error containing `UNIQUE constraint failed`.
  - `RETURNING`, window functions, row-value `IN` and `ON CONFLICT … DO UPDATE … WHERE` all work.
- **File-mode database uses one connection** (`SetMaxOpenConns(1)`). Never query through `s.db` while a transaction or an open `*sql.Rows` exists on the same goroutine. Close rows before the next statement.
- **No `FOREIGN KEY` clauses.** `PRAGMA foreign_keys` is per connection and can't be relied on over remote libSQL. The store deletes dependent rows explicitly.
- Booleans are stored as `INTEGER` 0/1, converted in Go. Never pass Go `bool` to the driver.
- Times are **Unix milliseconds** (`int64`) in the database and in the protocol (`*_ms` fields).
- ID formats:
  - user, device and vault IDs: 32 lowercase hex characters
  - `file_id`: 32 bytes
  - `version_id`: 16 bytes
  - `chunk_id`: 32 bytes
  - chunk IDs in URLs: 64 lowercase hex characters
- Chunks are **4 MiB plaintext** (`4 << 20`). An uploaded encrypted chunk is at most `4<<20 + 64` bytes.
- HTTP bodies are Protobuf with `Content-Type: application/x-protobuf`, except chunk bodies, which are raw `application/octet-stream`.
- **Never log** tokens, password hashes, passwords, key bundles, `enc_meta`, `enc_name` or chunk bytes. Vault IDs, device IDs, blob keys and paths are fine.
- Commit messages follow Conventional Commits and end with the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Run every Go command from `server/` unless a step says otherwise. Tests run with `go test -race`.

## Review Focus

These are the failure modes the spec implies but doesn't spell out, and the ones most likely to hurt a real user. Each one has a pinning test in the task that owns the code:

1. **A commit whose HTTP response was lost gets retried.** It must come back `ok` with the original `seq`, not `CONFLICT` against itself. Pinned in Task 7 by `TestCommitRetryIsIdempotent`.
2. **An upload stops partway through** (the body is shorter than `Content-Length`, or the client disconnects). It must leave no chunk row, no usage and no blob. Pinned in Task 11 by `TestPutChunkRejectsSizeMismatch`.
3. **A revoked device keeps an open WebSocket.** It must be cut off at its next ping. Pinned in Task 14 by `TestPingRevalidatesToken`.
4. **Paging exactly at a page boundary.** A full page reports `more=true` and the next page is empty with `more=false`, and `since` equal to the vault's `seq` returns nothing. Pinned in Task 7 by `TestHeadsPaging` and in Task 11 by `TestChangesPaging`.
5. **The server is stopped while devices hold WebSockets.** Shutdown must finish promptly instead of hanging on hijacked connections. Pinned in Task 16 by `TestEndToEnd` (its last step).

## File Structure

```
.gitignore
Makefile                         tools / proto / test / vet targets
buf.yaml, buf.gen.yaml           buf v2 module + Go generation
proto/obsync/v1/obsync.proto     the wire protocol
server/
  go.mod
  cmd/obsync/main.go             CLI entry: serve | migrate | admin
  internal/gen/obsync/v1/        generated code (do not edit) + roundtrip test
  internal/config/               defaults → YAML → env, validation
  internal/ids/                  random IDs
  internal/apperr/               typed errors carrying a protocol ErrorCode
  internal/store/                all SQL: open, migrations, users/devices/keys,
                                 vaults, chunks, sync log, retention jobs
    migrations/0001_init.sql
  internal/store/storetest/      temp store + clock + seed helpers for tests
  internal/blob/                 blob.Store interface + local FS implementation
    blobtest/                    contract suite every blob.Store must pass
  internal/bus/                  bus.Bus interface + in-memory implementation
    bustest/                     contract suite every bus.Bus must pass
  internal/auth/                 argon2id passwords, device tokens, login limiter, Service
  internal/syncsvc/              chunk upload/download, commit, changes, heads, history, trash
  internal/api/                  HTTP handlers, protobuf codec, error→status mapping
  internal/hub/                  WebSocket notifications
  internal/jobs/                 lease-guarded retention + chunk GC runner
  internal/admin/                `obsync admin user …`
  internal/app/                  wiring + graceful Serve; end-to-end test
```

---
### Task 1: Repository scaffolding and wire protocol

**Files:**
- Create: `.gitignore`, `Makefile`, `buf.yaml`, `buf.gen.yaml`
- Create: `proto/obsync/v1/obsync.proto`
- Create: `server/go.mod` (via `go mod init`)
- Generate: `server/internal/gen/obsync/v1/obsync.pb.go`
- Test: `server/internal/gen/obsync/v1/roundtrip_test.go`

**Interfaces:**
- Consumes: nothing.
- Produces: Go package `obsyncv1` (import path `github.com/jfms7s/obsidian-sync/server/internal/gen/obsync/v1`). Every message below becomes a Go struct with exported fields (`FileId`, `VersionId`, `ChunkIds`, `CreatedAtMs`, …). Enum constants are named like `obsyncv1.ErrorCode_ERROR_CODE_CONFLICT`. Oneof wrappers are named like `obsyncv1.ClientFrame_Auth{Auth: …}` and `obsyncv1.ServerFrame_Notify{Notify: …}`, with getters `GetAuth()`, `GetNotify()`, and so on.

- [ ] **Step 1: Create the repo-level files**

`.gitignore`:
```gitignore
/bin/
*.db
*.db-shm
*.db-wal
/server/obsync
node_modules/
```

`Makefile`:
```make
SHELL := /bin/bash
BIN := $(CURDIR)/bin
export PATH := $(BIN):$(PATH)
export GOTOOLCHAIN := local
export CGO_ENABLED := 1

.PHONY: tools proto proto-lint test vet

tools:
	GOBIN=$(BIN) go install github.com/bufbuild/buf/cmd/buf@v1.47.2
	GOBIN=$(BIN) go install google.golang.org/protobuf/cmd/protoc-gen-go@v1.35.2

proto-lint:
	buf lint

proto: proto-lint
	buf generate

test:
	cd server && go test -race ./...

vet:
	cd server && go vet ./...
```

`buf.yaml`:
```yaml
version: v2
modules:
  - path: proto
lint:
  use:
    - STANDARD
breaking:
  use:
    - FILE
```

`buf.gen.yaml`:
```yaml
version: v2
plugins:
  - local: protoc-gen-go
    out: server/internal/gen
    opt: paths=source_relative
```

- [ ] **Step 2: Write the protocol**

`proto/obsync/v1/obsync.proto`:
```proto
syntax = "proto3";

package obsync.v1;

option go_package = "github.com/jfms7s/obsidian-sync/server/internal/gen/obsync/v1;obsyncv1";

// ---------- Errors ----------

enum ErrorCode {
  ERROR_CODE_UNSPECIFIED = 0;
  ERROR_CODE_CONFLICT = 1;
  ERROR_CODE_QUOTA_EXCEEDED = 2;
  ERROR_CODE_UNAUTHORIZED = 3;
  ERROR_CODE_DEVICE_REVOKED = 4;
  ERROR_CODE_STALE_EPOCH = 5;
  ERROR_CODE_RATE_LIMITED = 6;
  ERROR_CODE_TOO_LARGE = 7;
  ERROR_CODE_NOT_FOUND = 8;
  ERROR_CODE_INTERNAL = 9;
  ERROR_CODE_INVALID = 10;
  ERROR_CODE_MISSING_CHUNK = 11;
}

message Error {
  ErrorCode code = 1;
  string message = 2;
}

// ---------- Accounts and devices ----------

message LoginRequest {
  string username = 1;
  string password = 2;
  string device_name = 3;
  string platform = 4;
}

message LoginResponse {
  string token = 1;
  string device_id = 2;
  string user_id = 3;
}

message Device {
  string device_id = 1;
  string name = 2;
  string platform = 3;
  int64 created_at_ms = 4;
  int64 last_seen_at_ms = 5;
  bool current = 6;
  bool revoked = 7;
}

message ListDevicesResponse {
  repeated Device devices = 1;
}

// ---------- User key material (opaque to the server) ----------

message Argon2Params {
  uint32 memory_kib = 1;
  uint32 iterations = 2;
  uint32 parallelism = 3;
}

message KeyBundle {
  bytes public_enc_key = 1;   // X25519, 32 bytes
  bytes public_sign_key = 2;  // Ed25519, 32 bytes
  bytes pass_salt = 3;
  Argon2Params pass_params = 4;
  bytes pass_wrapped = 5;     // private keys sealed under the passphrase KEK
  bytes recovery_wrapped = 6; // private keys sealed under the recovery KEK
}

// ---------- Vaults ----------

// epoch 0 is the vault's naming key; epochs >= 1 are content epoch keys.
message VaultKey {
  uint32 epoch = 1;
  bytes sealed_key = 2;
}

message Vault {
  string vault_id = 1;
  bytes enc_name = 2;
  uint32 current_epoch = 3;
  uint64 seq = 4;
  int64 created_at_ms = 5;
  string owner_id = 6;
}

message CreateVaultRequest {
  string vault_id = 1;
  bytes enc_name = 2;
  repeated VaultKey keys = 3;
}

message ListVaultsResponse {
  repeated Vault vaults = 1;
}

message VaultKeysResponse {
  repeated VaultKey keys = 1;
}

// ---------- Sync ----------

message Commit {
  bytes file_id = 1;
  bytes version_id = 2;
  bytes base_version_id = 3; // empty = the client believes the file is new
  uint32 epoch = 4;
  bytes enc_meta = 5;
  repeated bytes chunk_ids = 6;
  uint64 size = 7;
  bool deleted = 8;
}

message CommitRequest {
  repeated Commit commits = 1;
}

message CommitResult {
  bytes file_id = 1;
  bool ok = 2;
  uint64 seq = 3;
  Error error = 4;
  bytes head_version_id = 5; // the current head when error is CONFLICT
}

message CommitResponse {
  repeated CommitResult results = 1;
  uint64 vault_seq = 2;
}

message Version {
  bytes file_id = 1;
  bytes version_id = 2;
  bytes base_version_id = 3;
  uint32 epoch = 4;
  bytes enc_meta = 5;
  repeated bytes chunk_ids = 6;
  uint64 size = 7;
  bool deleted = 8;
  string device_id = 9;
  int64 created_at_ms = 10;
  uint64 seq = 11;
}

message ChangesResponse {
  repeated Version versions = 1;
  uint64 vault_seq = 2;
  bool more = 3;
}

message Head {
  bytes file_id = 1;
  bytes version_id = 2;
  uint64 seq = 3;
  bool deleted = 4;
}

message HeadsResponse {
  repeated Head heads = 1;
  bool more = 2;
}

// History of one file, or the vault's trash (tombstone heads), newest first.
message VersionsResponse {
  repeated Version versions = 1;
}

message ChunkExistsRequest {
  repeated bytes chunk_ids = 1;
}

message ChunkExistsResponse {
  repeated bool exists = 1;
}

// ---------- WebSocket frames ----------
// Each frame type is a oneof case; v2 live sessions add new cases.

message Auth {
  string token = 1;
}

message Subscribe {
  repeated string vault_ids = 1;
}

message Ping {
  uint64 nonce = 1;
}

message ClientFrame {
  oneof frame {
    Auth auth = 1;
    Subscribe subscribe = 2;
    Ping ping = 3;
  }
}

message AuthOk {
  string device_id = 1;
}

message Notify {
  string vault_id = 1;
  uint64 seq = 2;
}

message Pong {
  uint64 nonce = 1;
}

message ServerFrame {
  oneof frame {
    AuthOk auth_ok = 1;
    Notify notify = 2;
    Pong pong = 3;
    Error error = 4;
  }
}
```

- [ ] **Step 3: Create the Go module and install the generators**

Run:
```bash
cd server && GOTOOLCHAIN=local go mod init github.com/jfms7s/obsidian-sync/server && go mod edit -go=1.23 && GOTOOLCHAIN=local go get google.golang.org/protobuf@v1.35.2 && cd .. && make tools
```
Expected: `bin/buf` and `bin/protoc-gen-go` exist.

- [ ] **Step 4: Write the failing round-trip test**

`server/internal/gen/obsync/v1/roundtrip_test.go`:
```go
package obsyncv1_test

import (
	"bytes"
	"testing"

	"google.golang.org/protobuf/proto"

	obsyncv1 "github.com/jfms7s/obsidian-sync/server/internal/gen/obsync/v1"
)

func TestCommitRequestRoundTrip(t *testing.T) {
	in := &obsyncv1.CommitRequest{Commits: []*obsyncv1.Commit{{
		FileId:    bytes.Repeat([]byte{1}, 32),
		VersionId: bytes.Repeat([]byte{2}, 16),
		Epoch:     1,
		EncMeta:   []byte("meta"),
		ChunkIds:  [][]byte{bytes.Repeat([]byte{3}, 32)},
		Size:      5,
	}}}
	data, err := proto.Marshal(in)
	if err != nil {
		t.Fatal(err)
	}
	out := &obsyncv1.CommitRequest{}
	if err := proto.Unmarshal(data, out); err != nil {
		t.Fatal(err)
	}
	if !proto.Equal(in, out) {
		t.Fatalf("round trip changed the message:\n in: %v\nout: %v", in, out)
	}
}

func TestServerFrameOneof(t *testing.T) {
	f := &obsyncv1.ServerFrame{Frame: &obsyncv1.ServerFrame_Notify{Notify: &obsyncv1.Notify{VaultId: "v", Seq: 7}}}
	data, err := proto.Marshal(f)
	if err != nil {
		t.Fatal(err)
	}
	var got obsyncv1.ServerFrame
	if err := proto.Unmarshal(data, &got); err != nil {
		t.Fatal(err)
	}
	if got.GetNotify().GetSeq() != 7 {
		t.Fatalf("seq = %d, want 7", got.GetNotify().GetSeq())
	}
}
```

- [ ] **Step 5: Run it to verify it fails**

Run: `cd server && go test ./internal/gen/...`
Expected: FAIL because the package `obsyncv1` has no non-test Go files.

- [ ] **Step 6: Lint and generate**

Run: `make proto`
Expected: `buf lint` prints nothing, and `server/internal/gen/obsync/v1/obsync.pb.go` is created.

- [ ] **Step 7: Run the test to verify it passes**

Run: `cd server && go mod tidy && go test ./internal/gen/...`
Expected: `ok  github.com/jfms7s/obsidian-sync/server/internal/gen/obsync/v1`

- [ ] **Step 8: Commit**

```bash
git add .gitignore Makefile buf.yaml buf.gen.yaml proto server/go.mod server/go.sum server/internal/gen
git commit -m "feat(proto): add obsync v1 wire protocol and Go codegen

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Configuration

**Files:**
- Create: `server/internal/config/config.go`
- Test: `server/internal/config/config_test.go`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```go
  type Retention struct { HistoryDays, HistoryMaxVersions, TrashDays int }
  type Config struct {
      Listen, DataDir, DatabaseURL, DatabaseAuthToken, BlobBackend, BlobFSDir, LogLevel string
      Cluster bool
      DefaultQuotaBytes, MaxFileSizeBytes int64
      Retention Retention
      GCGraceHours, JobsIntervalMinutes int
  }
  func Defaults() Config
  func Load(path string, getenv func(string) string) (Config, error)
  func (c Config) Validate() error
  func (c Config) GCGrace() time.Duration
  func (c Config) JobsInterval() time.Duration
  ```

- [ ] **Step 1: Write the failing tests**

`server/internal/config/config_test.go`:
```go
package config_test

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/jfms7s/obsidian-sync/server/internal/config"
)

func env(m map[string]string) func(string) string {
	return func(k string) string { return m[k] }
}

func writeFile(t *testing.T, content string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "obsync.yaml")
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestLoadDefaults(t *testing.T) {
	cfg, err := config.Load("", env(nil))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Listen != ":8080" {
		t.Errorf("Listen = %q", cfg.Listen)
	}
	if cfg.DatabaseURL != "file:/data/meta.db" {
		t.Errorf("DatabaseURL = %q", cfg.DatabaseURL)
	}
	if cfg.BlobFSDir != "/data/blobs" {
		t.Errorf("BlobFSDir = %q", cfg.BlobFSDir)
	}
	if cfg.DefaultQuotaBytes != 10<<30 || cfg.MaxFileSizeBytes != 2<<30 {
		t.Errorf("quota/max = %d/%d", cfg.DefaultQuotaBytes, cfg.MaxFileSizeBytes)
	}
	if cfg.Retention != (config.Retention{HistoryDays: 30, HistoryMaxVersions: 0, TrashDays: 30}) {
		t.Errorf("Retention = %+v", cfg.Retention)
	}
}

func TestLoadYAMLThenEnv(t *testing.T) {
	path := writeFile(t, "listen: \":9000\"\ndata_dir: /srv/obsync\nretention:\n  trash_days: 7\n")
	cfg, err := config.Load(path, env(map[string]string{"OBSYNC_LISTEN": ":9100"}))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Listen != ":9100" {
		t.Errorf("env should override YAML, Listen = %q", cfg.Listen)
	}
	if cfg.DataDir != "/srv/obsync" || cfg.DatabaseURL != "file:/srv/obsync/meta.db" {
		t.Errorf("DataDir/DatabaseURL = %q/%q", cfg.DataDir, cfg.DatabaseURL)
	}
	if cfg.Retention.TrashDays != 7 || cfg.Retention.HistoryDays != 30 {
		t.Errorf("Retention = %+v", cfg.Retention)
	}
}

func TestLoadEmptyYAMLFile(t *testing.T) {
	if _, err := config.Load(writeFile(t, ""), env(nil)); err != nil {
		t.Fatalf("empty file should mean defaults: %v", err)
	}
}

func TestLoadRejectsUnknownYAMLField(t *testing.T) {
	_, err := config.Load(writeFile(t, "lisen: \":9000\"\n"), env(nil))
	if err == nil || !strings.Contains(err.Error(), "lisen") {
		t.Fatalf("err = %v, want mention of the unknown field", err)
	}
}

func TestLoadRejectsBadEnvInteger(t *testing.T) {
	_, err := config.Load("", env(map[string]string{"OBSYNC_TRASH_DAYS": "seven"}))
	if err == nil || !strings.Contains(err.Error(), "OBSYNC_TRASH_DAYS") {
		t.Fatalf("err = %v", err)
	}
}

func TestValidateRejectsUnavailableModes(t *testing.T) {
	_, err := config.Load("", env(map[string]string{"OBSYNC_CLUSTER": "true", "OBSYNC_BLOB_BACKEND": "s3"}))
	if err == nil {
		t.Fatal("expected an error")
	}
	for _, want := range []string{"cluster mode is not available yet", `blob_backend "s3"`} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error %q does not mention %q", err, want)
		}
	}
}

func TestValidateRejectsBadDatabaseScheme(t *testing.T) {
	_, err := config.Load("", env(map[string]string{"OBSYNC_DATABASE_URL": "postgres://db/obsync"}))
	if err == nil || !strings.Contains(err.Error(), `"postgres"`) {
		t.Fatalf("err = %v", err)
	}
}

func TestValidateRejectsNonPositiveLimits(t *testing.T) {
	_, err := config.Load("", env(map[string]string{"OBSYNC_DEFAULT_QUOTA_BYTES": "0", "OBSYNC_GC_GRACE_HOURS": "0"}))
	if err == nil {
		t.Fatal("expected an error")
	}
	for _, want := range []string{"default_quota_bytes", "gc_grace_hours"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error %q does not mention %q", err, want)
		}
	}
}
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd server && go test ./internal/config/`
Expected: FAIL because package `config` does not exist.

- [ ] **Step 3: Implement**

Run: `cd server && go get gopkg.in/yaml.v3@v3.0.1`

`server/internal/config/config.go`:
```go
// Package config loads obsync's settings: built-in defaults, then an
// optional YAML file, then OBSYNC_* environment variables, then validation.
package config

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"time"

	"gopkg.in/yaml.v3"
)

type Retention struct {
	HistoryDays        int `yaml:"history_days"`
	HistoryMaxVersions int `yaml:"history_max_versions"` // 0 = no count limit
	TrashDays          int `yaml:"trash_days"`
}

type Config struct {
	Listen              string    `yaml:"listen"`
	DataDir             string    `yaml:"data_dir"`
	DatabaseURL         string    `yaml:"database_url"`
	DatabaseAuthToken   string    `yaml:"database_auth_token"`
	BlobBackend         string    `yaml:"blob_backend"`
	BlobFSDir           string    `yaml:"blob_fs_dir"`
	Cluster             bool      `yaml:"cluster"`
	DefaultQuotaBytes   int64     `yaml:"default_quota_bytes"`
	MaxFileSizeBytes    int64     `yaml:"max_file_size_bytes"`
	Retention           Retention `yaml:"retention"`
	GCGraceHours        int       `yaml:"gc_grace_hours"`
	JobsIntervalMinutes int       `yaml:"jobs_interval_minutes"`
	LogLevel            string    `yaml:"log_level"`
}

func Defaults() Config {
	return Config{
		Listen:              ":8080",
		DataDir:             "/data",
		BlobBackend:         "fs",
		DefaultQuotaBytes:   10 << 30,
		MaxFileSizeBytes:    2 << 30,
		Retention:           Retention{HistoryDays: 30, TrashDays: 30},
		GCGraceHours:        24,
		JobsIntervalMinutes: 60,
		LogLevel:            "info",
	}
}

// Load builds the effective configuration. path may be empty (no file).
func Load(path string, getenv func(string) string) (Config, error) {
	cfg := Defaults()
	if path != "" {
		data, err := os.ReadFile(path)
		if err != nil {
			return Config{}, fmt.Errorf("read config file: %w", err)
		}
		dec := yaml.NewDecoder(bytes.NewReader(data))
		dec.KnownFields(true)
		if err := dec.Decode(&cfg); err != nil && !errors.Is(err, io.EOF) {
			return Config{}, fmt.Errorf("parse config file %s: %w", path, err)
		}
	}
	if err := applyEnv(&cfg, getenv); err != nil {
		return Config{}, err
	}
	cfg.fillDerived()
	if err := cfg.Validate(); err != nil {
		return Config{}, err
	}
	return cfg, nil
}

func applyEnv(c *Config, getenv func(string) string) error {
	var errs []error
	str := func(name string, dst *string) {
		if v := getenv(name); v != "" {
			*dst = v
		}
	}
	integer := func(name string, dst *int) {
		if v := getenv(name); v != "" {
			n, err := strconv.Atoi(v)
			if err != nil {
				errs = append(errs, fmt.Errorf("%s: %q is not an integer", name, v))
				return
			}
			*dst = n
		}
	}
	integer64 := func(name string, dst *int64) {
		if v := getenv(name); v != "" {
			n, err := strconv.ParseInt(v, 10, 64)
			if err != nil {
				errs = append(errs, fmt.Errorf("%s: %q is not an integer", name, v))
				return
			}
			*dst = n
		}
	}
	boolean := func(name string, dst *bool) {
		if v := getenv(name); v != "" {
			b, err := strconv.ParseBool(v)
			if err != nil {
				errs = append(errs, fmt.Errorf("%s: %q is not a boolean", name, v))
				return
			}
			*dst = b
		}
	}

	str("OBSYNC_LISTEN", &c.Listen)
	str("OBSYNC_DATA_DIR", &c.DataDir)
	str("OBSYNC_DATABASE_URL", &c.DatabaseURL)
	str("OBSYNC_DATABASE_AUTH_TOKEN", &c.DatabaseAuthToken)
	str("OBSYNC_BLOB_BACKEND", &c.BlobBackend)
	str("OBSYNC_BLOB_FS_DIR", &c.BlobFSDir)
	boolean("OBSYNC_CLUSTER", &c.Cluster)
	integer64("OBSYNC_DEFAULT_QUOTA_BYTES", &c.DefaultQuotaBytes)
	integer64("OBSYNC_MAX_FILE_SIZE_BYTES", &c.MaxFileSizeBytes)
	integer("OBSYNC_HISTORY_DAYS", &c.Retention.HistoryDays)
	integer("OBSYNC_HISTORY_MAX_VERSIONS", &c.Retention.HistoryMaxVersions)
	integer("OBSYNC_TRASH_DAYS", &c.Retention.TrashDays)
	integer("OBSYNC_GC_GRACE_HOURS", &c.GCGraceHours)
	integer("OBSYNC_JOBS_INTERVAL_MINUTES", &c.JobsIntervalMinutes)
	str("OBSYNC_LOG_LEVEL", &c.LogLevel)
	return errors.Join(errs...)
}

func (c *Config) fillDerived() {
	if c.DatabaseURL == "" {
		c.DatabaseURL = "file:" + filepath.Join(c.DataDir, "meta.db")
	}
	if c.BlobFSDir == "" {
		c.BlobFSDir = filepath.Join(c.DataDir, "blobs")
	}
}

// Validate reports every problem at once so an operator fixes them in one go.
func (c Config) Validate() error {
	var errs []error
	add := func(format string, args ...any) { errs = append(errs, fmt.Errorf(format, args...)) }

	if c.Listen == "" {
		add("listen must not be empty")
	}
	if c.DataDir == "" {
		add("data_dir must not be empty")
	}
	// Only the scheme is ever echoed: the URL may carry credentials.
	if u, err := url.Parse(c.DatabaseURL); err != nil {
		add("database_url is not a valid URL")
	} else {
		switch u.Scheme {
		case "file", "libsql", "http", "https":
		default:
			add("database_url scheme %q is not supported (use file:, libsql://, http:// or https://)", u.Scheme)
		}
	}
	switch c.BlobBackend {
	case "fs":
	case "s3":
		add(`blob_backend "s3" is not available yet; it arrives with clustered mode`)
	default:
		add("blob_backend %q is not supported (use \"fs\")", c.BlobBackend)
	}
	if c.Cluster {
		add("cluster mode is not available yet")
	}
	if c.DefaultQuotaBytes <= 0 {
		add("default_quota_bytes must be positive")
	}
	if c.MaxFileSizeBytes <= 0 {
		add("max_file_size_bytes must be positive")
	}
	if c.Retention.HistoryDays < 0 || c.Retention.HistoryMaxVersions < 0 || c.Retention.TrashDays < 0 {
		add("retention values must not be negative")
	}
	if c.GCGraceHours < 1 {
		add("gc_grace_hours must be at least 1")
	}
	if c.JobsIntervalMinutes < 1 {
		add("jobs_interval_minutes must be at least 1")
	}
	switch c.LogLevel {
	case "debug", "info", "warn", "error":
	default:
		add("log_level %q is not one of debug, info, warn, error", c.LogLevel)
	}
	return errors.Join(errs...)
}

func (c Config) GCGrace() time.Duration { return time.Duration(c.GCGraceHours) * time.Hour }

func (c Config) JobsInterval() time.Duration {
	return time.Duration(c.JobsIntervalMinutes) * time.Minute
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd server && go mod tidy && go test -race ./internal/config/`
Expected: `ok`

- [ ] **Step 5: Commit**

```bash
git add server/go.mod server/go.sum server/internal/config
git commit -m "feat(server): load and validate configuration

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Store foundation: open, migrations, IDs, test helpers

**Files:**
- Create: `server/internal/ids/ids.go`, `server/internal/ids/ids_test.go`
- Create: `server/internal/store/store.go`, `server/internal/store/errors.go`, `server/internal/store/migrate.go`
- Create: `server/internal/store/migrations/0001_init.sql`
- Create: `server/internal/store/storetest/storetest.go`
- Test: `server/internal/store/migrate_test.go`, `server/internal/store/split_internal_test.go`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```go
  // package ids
  func New() string            // 32 lowercase hex chars
  func Bytes(n int) []byte     // n random bytes
  func Valid(id string) bool   // matches ^[0-9a-f]{32}$

  // package store
  type Options struct { URL, AuthToken string; Now func() time.Time }
  func Open(ctx context.Context, opts Options) (*Store, error)
  func (s *Store) Close() error
  func (s *Store) Ping(ctx context.Context) error
  func (s *Store) Migrate(ctx context.Context) error
  var ErrNotFound, ErrExists, ErrKeyMismatch error
  // unexported, used by later store files:
  func (s *Store) withTx(ctx context.Context, fn func(*sql.Tx) error) error
  func (s *Store) nowMs() int64
  func isUniqueViolation(err error) bool
  func nonNil(b []byte) []byte
  func boolInt(b bool) int64
  type rowScanner interface{ Scan(dest ...any) error }

  // package storetest
  type Clock struct{ … }
  func NewClock() *Clock
  func (c *Clock) Now() time.Time
  func (c *Clock) Advance(d time.Duration)
  func New(t testing.TB) (*store.Store, *Clock)  // migrated store in t.TempDir()
  ```

- [ ] **Step 1: Write the failing tests**

`server/internal/ids/ids_test.go`:
```go
package ids_test

import (
	"testing"

	"github.com/jfms7s/obsidian-sync/server/internal/ids"
)

func TestNewIsValidAndUnique(t *testing.T) {
	a, b := ids.New(), ids.New()
	if !ids.Valid(a) || !ids.Valid(b) {
		t.Fatalf("invalid ids %q %q", a, b)
	}
	if a == b {
		t.Fatal("two ids are equal")
	}
}

func TestValidRejects(t *testing.T) {
	for _, s := range []string{"", "ABCDEF0123456789ABCDEF0123456789", "abc", "../../../etc/passwd0000000000000"} {
		if ids.Valid(s) {
			t.Errorf("Valid(%q) = true", s)
		}
	}
}

func TestBytesLength(t *testing.T) {
	if got := len(ids.Bytes(16)); got != 16 {
		t.Fatalf("len = %d", got)
	}
}
```

`server/internal/store/split_internal_test.go`:
```go
package store

import (
	"reflect"
	"testing"
)

func TestSplitStatements(t *testing.T) {
	src := "-- a comment\nCREATE TABLE a (\n    x INTEGER\n);\n\nCREATE INDEX a_x ON a (x);\n"
	got := splitStatements(src)
	want := []string{"CREATE TABLE a (\n    x INTEGER\n);", "CREATE INDEX a_x ON a (x);"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %q\nwant %q", got, want)
	}
}
```

`server/internal/store/migrate_test.go`:
```go
package store_test

import (
	"context"
	"testing"

	"github.com/jfms7s/obsidian-sync/server/internal/store/storetest"
)

func TestMigrateCreatesSchema(t *testing.T) {
	st, _ := storetest.New(t)
	for _, table := range []string{
		"users", "devices", "key_bundles", "vaults", "vault_members", "vault_keys",
		"files", "versions", "version_chunks", "chunks", "job_leases", "schema_migrations",
	} {
		if !st.HasTableForTest(context.Background(), table) {
			t.Errorf("table %s missing", table)
		}
	}
}

func TestMigrateIsIdempotent(t *testing.T) {
	st, _ := storetest.New(t)
	if err := st.Migrate(context.Background()); err != nil {
		t.Fatalf("second migrate: %v", err)
	}
	if n := st.AppliedMigrationsForTest(context.Background()); n != 1 {
		t.Fatalf("applied migrations = %d, want 1", n)
	}
}
```

The two `…ForTest` helpers are small exported inspection methods in `migrate.go`. The store keeps its `*sql.DB` private, so the tests have no other way to look at the schema.

- [ ] **Step 2: Run them to verify they fail**

Run: `cd server && go test ./internal/ids/ ./internal/store/...`
Expected: FAIL because the packages don't exist.

- [ ] **Step 3: Implement `ids`**

`server/internal/ids/ids.go`:
```go
// Package ids generates the random identifiers obsync uses.
package ids

import (
	"crypto/rand"
	"encoding/hex"
	"regexp"
)

var hexID = regexp.MustCompile(`^[0-9a-f]{32}$`)

// New returns 16 random bytes as 32 lowercase hex characters.
func New() string { return hex.EncodeToString(Bytes(16)) }

// Bytes returns n cryptographically random bytes.
func Bytes(n int) []byte {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic("crypto/rand failed: " + err.Error())
	}
	return b
}

// Valid reports whether id has the format New produces.
func Valid(id string) bool { return hexID.MatchString(id) }
```

- [ ] **Step 4: Add the driver and implement the store foundation**

Run: `cd server && go get github.com/tursodatabase/go-libsql@v0.0.0-20260424063416-3051e37e6e04`

`server/internal/store/errors.go`:
```go
package store

import (
	"errors"
	"strings"
)

var (
	ErrNotFound    = errors.New("store: not found")
	ErrExists      = errors.New("store: already exists")
	ErrKeyMismatch = errors.New("store: public keys differ from the stored key bundle")
)

func isUniqueViolation(err error) bool {
	return err != nil && strings.Contains(err.Error(), "UNIQUE constraint failed")
}

// nonNil keeps the stored value an empty blob whatever the driver does with nil.
func nonNil(b []byte) []byte {
	if b == nil {
		return []byte{}
	}
	return b
}

func boolInt(b bool) int64 {
	if b {
		return 1
	}
	return 0
}

type rowScanner interface {
	Scan(dest ...any) error
}
```

`server/internal/store/store.go`:
```go
// Package store owns every SQL statement obsync runs against libSQL: a local
// file by default, or sqld / Turso Cloud over a direct primary connection.
package store

import (
	"context"
	"database/sql"
	"fmt"
	"net/url"
	"strings"
	"time"

	_ "github.com/tursodatabase/go-libsql"
)

type Store struct {
	db  *sql.DB
	now func() time.Time
}

type Options struct {
	URL       string // file:/path/meta.db, libsql://…, http(s)://…
	AuthToken string // remote databases only
	Now       func() time.Time
}

func Open(ctx context.Context, opts Options) (*Store, error) {
	dsn := opts.URL
	local := strings.HasPrefix(opts.URL, "file:")
	if !local && opts.AuthToken != "" {
		u, err := url.Parse(opts.URL)
		if err != nil {
			return nil, fmt.Errorf("parse database url: %w", err)
		}
		q := u.Query()
		q.Set("authToken", opts.AuthToken)
		u.RawQuery = q.Encode()
		dsn = u.String()
	}
	db, err := sql.Open("libsql", dsn)
	if err != nil {
		return nil, fmt.Errorf("open database: %w", err)
	}
	if local {
		// A local libSQL file has a single writer. One pooled connection
		// serialises all access instead of failing with SQLITE_BUSY, so code
		// must never use s.db while it holds a transaction or open rows.
		db.SetMaxOpenConns(1)
		var mode string
		if err := db.QueryRowContext(ctx, "PRAGMA journal_mode=WAL").Scan(&mode); err != nil {
			db.Close()
			return nil, fmt.Errorf("enable WAL: %w", err)
		}
	}
	if err := db.PingContext(ctx); err != nil {
		db.Close()
		return nil, fmt.Errorf("ping database: %w", err)
	}
	now := opts.Now
	if now == nil {
		now = time.Now
	}
	return &Store{db: db, now: now}, nil
}

func (s *Store) Close() error { return s.db.Close() }

func (s *Store) Ping(ctx context.Context) error { return s.db.PingContext(ctx) }

func (s *Store) nowMs() int64 { return s.now().UnixMilli() }

func (s *Store) withTx(ctx context.Context, fn func(*sql.Tx) error) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin transaction: %w", err)
	}
	if err := fn(tx); err != nil {
		_ = tx.Rollback()
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit transaction: %w", err)
	}
	return nil
}
```

`server/internal/store/migrations/0001_init.sql`:
```sql
-- 0001_init: core sync schema.
-- No FOREIGN KEY clauses: PRAGMA foreign_keys is per connection and cannot be
-- relied on over remote libSQL, so the store deletes dependent rows itself.
-- One statement per ';'-terminated line group: go-libsql's Exec runs only the
-- first statement of a string, so migrate.go splits this file.

CREATE TABLE users (
    id            TEXT PRIMARY KEY,
    username      TEXT NOT NULL COLLATE NOCASE UNIQUE,
    password_hash TEXT NOT NULL,
    quota_bytes   INTEGER NOT NULL,
    created_at    INTEGER NOT NULL
);

CREATE TABLE devices (
    id           TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL,
    token_hash   BLOB NOT NULL UNIQUE,
    name         TEXT NOT NULL,
    platform     TEXT NOT NULL,
    created_at   INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    revoked_at   INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX devices_user ON devices (user_id);

CREATE TABLE key_bundles (
    user_id         TEXT PRIMARY KEY,
    public_enc_key  BLOB NOT NULL,
    public_sign_key BLOB NOT NULL,
    bundle          BLOB NOT NULL,
    updated_at      INTEGER NOT NULL
);

CREATE TABLE vaults (
    id            TEXT PRIMARY KEY,
    owner_id      TEXT NOT NULL,
    enc_name      BLOB NOT NULL,
    seq           INTEGER NOT NULL DEFAULT 0,
    current_epoch INTEGER NOT NULL DEFAULT 1,
    bytes_used    INTEGER NOT NULL DEFAULT 0,
    created_at    INTEGER NOT NULL
);

CREATE INDEX vaults_owner ON vaults (owner_id);

CREATE TABLE vault_members (
    vault_id TEXT NOT NULL,
    user_id  TEXT NOT NULL,
    role     TEXT NOT NULL,
    PRIMARY KEY (vault_id, user_id)
);

CREATE INDEX vault_members_user ON vault_members (user_id);

CREATE TABLE vault_keys (
    vault_id   TEXT NOT NULL,
    user_id    TEXT NOT NULL,
    epoch      INTEGER NOT NULL,
    sealed_key BLOB NOT NULL,
    PRIMARY KEY (vault_id, user_id, epoch)
);

CREATE TABLE files (
    vault_id        TEXT NOT NULL,
    file_id         BLOB NOT NULL,
    head_version_id BLOB NOT NULL,
    PRIMARY KEY (vault_id, file_id)
);

CREATE TABLE versions (
    vault_id        TEXT NOT NULL,
    version_id      BLOB NOT NULL,
    file_id         BLOB NOT NULL,
    base_version_id BLOB NOT NULL,
    epoch           INTEGER NOT NULL,
    enc_meta        BLOB NOT NULL,
    size            INTEGER NOT NULL,
    deleted         INTEGER NOT NULL,
    device_id       TEXT NOT NULL,
    created_at      INTEGER NOT NULL,
    seq             INTEGER NOT NULL,
    PRIMARY KEY (vault_id, version_id)
);

CREATE UNIQUE INDEX versions_seq ON versions (vault_id, seq);

CREATE INDEX versions_file ON versions (vault_id, file_id, seq);

CREATE INDEX versions_created ON versions (created_at);

CREATE TABLE version_chunks (
    vault_id   TEXT NOT NULL,
    version_id BLOB NOT NULL,
    idx        INTEGER NOT NULL,
    chunk_id   BLOB NOT NULL,
    PRIMARY KEY (vault_id, version_id, idx)
);

CREATE INDEX version_chunks_chunk ON version_chunks (vault_id, chunk_id);

CREATE TABLE chunks (
    vault_id   TEXT NOT NULL,
    chunk_id   BLOB NOT NULL,
    blob_key   TEXT NOT NULL,
    size       INTEGER NOT NULL,
    touched_at INTEGER NOT NULL,
    PRIMARY KEY (vault_id, chunk_id)
);

CREATE INDEX chunks_touched ON chunks (touched_at);

CREATE TABLE job_leases (
    name       TEXT PRIMARY KEY,
    holder     TEXT NOT NULL,
    expires_at INTEGER NOT NULL
);
```

`server/internal/store/migrate.go`:
```go
package store

import (
	"context"
	"database/sql"
	"embed"
	"fmt"
	"io/fs"
	"strconv"
	"strings"
)

//go:embed migrations/*.sql
var migrationFS embed.FS

// Migrate applies every migration in migrations/ that has not run yet, each in
// its own transaction, in file-name order.
func (s *Store) Migrate(ctx context.Context) error {
	if _, err := s.db.ExecContext(ctx,
		`CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)`); err != nil {
		return fmt.Errorf("create schema_migrations: %w", err)
	}
	entries, err := fs.ReadDir(migrationFS, "migrations")
	if err != nil {
		return fmt.Errorf("list migrations: %w", err)
	}
	for _, e := range entries {
		version, err := strconv.Atoi(strings.SplitN(e.Name(), "_", 2)[0])
		if err != nil {
			return fmt.Errorf("migration %s: name must start with a number", e.Name())
		}
		var applied int
		if err := s.db.QueryRowContext(ctx,
			`SELECT COUNT(*) FROM schema_migrations WHERE version = ?`, version).Scan(&applied); err != nil {
			return fmt.Errorf("check migration %d: %w", version, err)
		}
		if applied > 0 {
			continue
		}
		src, err := migrationFS.ReadFile("migrations/" + e.Name())
		if err != nil {
			return fmt.Errorf("read migration %s: %w", e.Name(), err)
		}
		err = s.withTx(ctx, func(tx *sql.Tx) error {
			for _, stmt := range splitStatements(string(src)) {
				if _, err := tx.ExecContext(ctx, stmt); err != nil {
					return fmt.Errorf("migration %s: %w", e.Name(), err)
				}
			}
			_, err := tx.ExecContext(ctx,
				`INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)`, version, s.nowMs())
			return err
		})
		if err != nil {
			return err
		}
	}
	return nil
}

// splitStatements splits a migration into single statements, because
// go-libsql's Exec runs only the first statement of a multi-statement string
// and silently ignores the rest. A statement ends at a line ending in ';'.
// Blank lines and lines starting with "--" are dropped.
func splitStatements(src string) []string {
	var stmts []string
	var cur strings.Builder
	for _, line := range strings.Split(src, "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasPrefix(trimmed, "--") {
			continue
		}
		cur.WriteString(line)
		cur.WriteString("\n")
		if strings.HasSuffix(trimmed, ";") {
			stmts = append(stmts, strings.TrimSpace(cur.String()))
			cur.Reset()
		}
	}
	if rest := strings.TrimSpace(cur.String()); rest != "" {
		stmts = append(stmts, rest)
	}
	return stmts
}

// HasTableForTest reports whether a table exists. Test-only inspection.
func (s *Store) HasTableForTest(ctx context.Context, name string) bool {
	var n int
	_ = s.db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?`, name).Scan(&n)
	return n == 1
}

// AppliedMigrationsForTest counts applied migrations. Test-only inspection.
func (s *Store) AppliedMigrationsForTest(ctx context.Context) int {
	var n int
	_ = s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM schema_migrations`).Scan(&n)
	return n
}
```

`server/internal/store/storetest/storetest.go`:
```go
// Package storetest gives tests in any package a migrated store in a
// temporary directory and a clock they control.
package storetest

import (
	"context"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/jfms7s/obsidian-sync/server/internal/store"
)

type Clock struct {
	mu sync.Mutex
	t  time.Time
}

func NewClock() *Clock { return &Clock{t: time.UnixMilli(1_700_000_000_000).UTC()} }

func (c *Clock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.t
}

func (c *Clock) Advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.t = c.t.Add(d)
}

// New returns a migrated store backed by a file in t.TempDir().
func New(t testing.TB) (*store.Store, *Clock) {
	t.Helper()
	clk := NewClock()
	st, err := store.Open(context.Background(), store.Options{
		URL: "file:" + filepath.Join(t.TempDir(), "meta.db"),
		Now: clk.Now,
	})
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })
	if err := st.Migrate(context.Background()); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	return st, clk
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd server && go mod tidy && go test -race ./internal/ids/ ./internal/store/...`
Expected: `ok` for `ids` and `store`.

- [ ] **Step 6: Commit**

```bash
git add server
git commit -m "feat(store): open libSQL and apply embedded migrations

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 4: Store: users, devices, key bundles

**Files:**
- Create: `server/internal/store/users.go`
- Modify: `server/internal/store/storetest/storetest.go` (add `SeedUser`)
- Test: `server/internal/store/users_test.go`

**Interfaces:**
- Consumes: `withTx`, `nowMs`, `isUniqueViolation`, `rowScanner`, `ErrNotFound`, `ErrExists`, `ErrKeyMismatch` (Task 3).
- Produces:
  ```go
  type User struct { ID, Username, PasswordHash string; QuotaBytes, CreatedAtMs int64 }
  func (s *Store) CreateUser(ctx context.Context, u User) error            // ErrExists on duplicate username (case-insensitive)
  func (s *Store) UserByUsername(ctx context.Context, username string) (User, error) // ErrNotFound
  func (s *Store) UserByID(ctx context.Context, id string) (User, error)             // ErrNotFound
  func (s *Store) ListUsers(ctx context.Context) ([]User, error)
  func (s *Store) SetPassword(ctx context.Context, userID, hash string) error        // ErrNotFound

  type Device struct { ID, UserID, Name, Platform string; CreatedAtMs, LastSeenAtMs, RevokedAtMs int64 }
  func (d Device) Revoked() bool
  func (s *Store) CreateDevice(ctx context.Context, d Device, tokenHash []byte) error
  func (s *Store) DeviceByTokenHash(ctx context.Context, tokenHash []byte) (Device, error) // ErrNotFound
  func (s *Store) ListDevices(ctx context.Context, userID string) ([]Device, error)
  func (s *Store) RevokeDevice(ctx context.Context, userID, deviceID string) error         // ErrNotFound if not the user's
  func (s *Store) TouchDevice(ctx context.Context, deviceID string) error

  type KeyBundle struct { PublicEncKey, PublicSignKey, Bundle []byte; UpdatedAtMs int64 }
  func (s *Store) KeyBundle(ctx context.Context, userID string) (KeyBundle, error)   // ErrNotFound
  func (s *Store) PutKeyBundle(ctx context.Context, userID string, kb KeyBundle) error // ErrKeyMismatch

  // storetest
  func SeedUser(t testing.TB, st *store.Store, username string) store.User // quota 1 GiB
  ```

- [ ] **Step 1: Write the failing tests**

`server/internal/store/users_test.go`:
```go
package store_test

import (
	"bytes"
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jfms7s/obsidian-sync/server/internal/ids"
	"github.com/jfms7s/obsidian-sync/server/internal/store"
	"github.com/jfms7s/obsidian-sync/server/internal/store/storetest"
)

var ctx = context.Background()

func TestCreateAndFindUserCaseInsensitively(t *testing.T) {
	st, clk := storetest.New(t)
	u := store.User{ID: ids.New(), Username: "Alice", PasswordHash: "h", QuotaBytes: 100}
	if err := st.CreateUser(ctx, u); err != nil {
		t.Fatal(err)
	}
	got, err := st.UserByUsername(ctx, "alice")
	if err != nil {
		t.Fatal(err)
	}
	if got.ID != u.ID || got.Username != "Alice" || got.QuotaBytes != 100 || got.CreatedAtMs != clk.Now().UnixMilli() {
		t.Fatalf("got %+v", got)
	}
	if err := st.CreateUser(ctx, store.User{ID: ids.New(), Username: "ALICE", PasswordHash: "h", QuotaBytes: 1}); !errors.Is(err, store.ErrExists) {
		t.Fatalf("duplicate username err = %v, want ErrExists", err)
	}
}

func TestUserNotFound(t *testing.T) {
	st, _ := storetest.New(t)
	if _, err := st.UserByUsername(ctx, "nobody"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("err = %v", err)
	}
	if _, err := st.UserByID(ctx, ids.New()); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("err = %v", err)
	}
	if err := st.SetPassword(ctx, ids.New(), "x"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("err = %v", err)
	}
}

func TestSetPasswordAndListUsers(t *testing.T) {
	st, _ := storetest.New(t)
	bob := storetest.SeedUser(t, st, "bob")
	storetest.SeedUser(t, st, "alice")
	if err := st.SetPassword(ctx, bob.ID, "new-hash"); err != nil {
		t.Fatal(err)
	}
	got, _ := st.UserByID(ctx, bob.ID)
	if got.PasswordHash != "new-hash" {
		t.Fatalf("hash = %q", got.PasswordHash)
	}
	users, err := st.ListUsers(ctx)
	if err != nil || len(users) != 2 || users[0].Username != "alice" {
		t.Fatalf("users = %+v, err = %v", users, err)
	}
}

func TestDeviceLifecycle(t *testing.T) {
	st, clk := storetest.New(t)
	alice := storetest.SeedUser(t, st, "alice")
	bob := storetest.SeedUser(t, st, "bob")
	hash := bytes.Repeat([]byte{9}, 32)
	dev := store.Device{ID: ids.New(), UserID: alice.ID, Name: "laptop", Platform: "linux"}
	if err := st.CreateDevice(ctx, dev, hash); err != nil {
		t.Fatal(err)
	}
	got, err := st.DeviceByTokenHash(ctx, hash)
	if err != nil || got.ID != dev.ID || got.Revoked() || got.LastSeenAtMs != clk.Now().UnixMilli() {
		t.Fatalf("got %+v, err %v", got, err)
	}
	if _, err := st.DeviceByTokenHash(ctx, bytes.Repeat([]byte{8}, 32)); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("unknown hash err = %v", err)
	}

	clk.Advance(time.Hour)
	if err := st.TouchDevice(ctx, dev.ID); err != nil {
		t.Fatal(err)
	}
	if got, _ := st.DeviceByTokenHash(ctx, hash); got.LastSeenAtMs != clk.Now().UnixMilli() {
		t.Fatalf("last seen not updated: %+v", got)
	}

	if err := st.RevokeDevice(ctx, bob.ID, dev.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("revoking another user's device err = %v", err)
	}
	if err := st.RevokeDevice(ctx, alice.ID, dev.ID); err != nil {
		t.Fatal(err)
	}
	if got, _ := st.DeviceByTokenHash(ctx, hash); !got.Revoked() {
		t.Fatal("device not revoked")
	}
	devices, err := st.ListDevices(ctx, alice.ID)
	if err != nil || len(devices) != 1 || !devices[0].Revoked() {
		t.Fatalf("devices = %+v, err %v", devices, err)
	}
}

func TestKeyBundle(t *testing.T) {
	st, _ := storetest.New(t)
	u := storetest.SeedUser(t, st, "alice")
	if _, err := st.KeyBundle(ctx, u.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("err = %v", err)
	}
	enc, sign := bytes.Repeat([]byte{1}, 32), bytes.Repeat([]byte{2}, 32)
	if err := st.PutKeyBundle(ctx, u.ID, store.KeyBundle{PublicEncKey: enc, PublicSignKey: sign, Bundle: []byte("v1")}); err != nil {
		t.Fatal(err)
	}
	if err := st.PutKeyBundle(ctx, u.ID, store.KeyBundle{PublicEncKey: enc, PublicSignKey: sign, Bundle: []byte("v2")}); err != nil {
		t.Fatalf("re-wrapping with the same public keys must succeed: %v", err)
	}
	got, err := st.KeyBundle(ctx, u.ID)
	if err != nil || string(got.Bundle) != "v2" {
		t.Fatalf("got %+v, err %v", got, err)
	}
	err = st.PutKeyBundle(ctx, u.ID, store.KeyBundle{PublicEncKey: bytes.Repeat([]byte{3}, 32), PublicSignKey: sign, Bundle: []byte("v3")})
	if !errors.Is(err, store.ErrKeyMismatch) {
		t.Fatalf("changed public key err = %v, want ErrKeyMismatch", err)
	}
}
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd server && go test ./internal/store/`
Expected: FAIL to compile with `st.CreateUser undefined`.

- [ ] **Step 3: Implement**

`server/internal/store/users.go`:
```go
package store

import (
	"bytes"
	"context"
	"database/sql"
	"errors"
	"fmt"
)

type User struct {
	ID           string
	Username     string
	PasswordHash string
	QuotaBytes   int64
	CreatedAtMs  int64
}

const userColumns = `id, username, password_hash, quota_bytes, created_at`

func scanUser(row rowScanner) (User, error) {
	var u User
	err := row.Scan(&u.ID, &u.Username, &u.PasswordHash, &u.QuotaBytes, &u.CreatedAtMs)
	if errors.Is(err, sql.ErrNoRows) {
		return User{}, ErrNotFound
	}
	if err != nil {
		return User{}, fmt.Errorf("scan user: %w", err)
	}
	return u, nil
}

func (s *Store) CreateUser(ctx context.Context, u User) error {
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO users (id, username, password_hash, quota_bytes, created_at) VALUES (?, ?, ?, ?, ?)`,
		u.ID, u.Username, u.PasswordHash, u.QuotaBytes, s.nowMs())
	if isUniqueViolation(err) {
		return ErrExists
	}
	if err != nil {
		return fmt.Errorf("create user: %w", err)
	}
	return nil
}

func (s *Store) UserByUsername(ctx context.Context, username string) (User, error) {
	return scanUser(s.db.QueryRowContext(ctx, `SELECT `+userColumns+` FROM users WHERE username = ?`, username))
}

func (s *Store) UserByID(ctx context.Context, id string) (User, error) {
	return scanUser(s.db.QueryRowContext(ctx, `SELECT `+userColumns+` FROM users WHERE id = ?`, id))
}

func (s *Store) ListUsers(ctx context.Context) ([]User, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT `+userColumns+` FROM users ORDER BY username`)
	if err != nil {
		return nil, fmt.Errorf("list users: %w", err)
	}
	defer rows.Close()
	var out []User
	for rows.Next() {
		u, err := scanUser(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, u)
	}
	return out, rows.Err()
}

func (s *Store) SetPassword(ctx context.Context, userID, hash string) error {
	res, err := s.db.ExecContext(ctx, `UPDATE users SET password_hash = ? WHERE id = ?`, hash, userID)
	if err != nil {
		return fmt.Errorf("set password: %w", err)
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

type Device struct {
	ID           string
	UserID       string
	Name         string
	Platform     string
	CreatedAtMs  int64
	LastSeenAtMs int64
	RevokedAtMs  int64 // 0 while the device is active
}

func (d Device) Revoked() bool { return d.RevokedAtMs != 0 }

const deviceColumns = `id, user_id, name, platform, created_at, last_seen_at, revoked_at`

func scanDevice(row rowScanner) (Device, error) {
	var d Device
	err := row.Scan(&d.ID, &d.UserID, &d.Name, &d.Platform, &d.CreatedAtMs, &d.LastSeenAtMs, &d.RevokedAtMs)
	if errors.Is(err, sql.ErrNoRows) {
		return Device{}, ErrNotFound
	}
	if err != nil {
		return Device{}, fmt.Errorf("scan device: %w", err)
	}
	return d, nil
}

func (s *Store) CreateDevice(ctx context.Context, d Device, tokenHash []byte) error {
	now := s.nowMs()
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO devices (id, user_id, token_hash, name, platform, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
		d.ID, d.UserID, tokenHash, d.Name, d.Platform, now, now)
	if err != nil {
		return fmt.Errorf("create device: %w", err)
	}
	return nil
}

func (s *Store) DeviceByTokenHash(ctx context.Context, tokenHash []byte) (Device, error) {
	return scanDevice(s.db.QueryRowContext(ctx, `SELECT `+deviceColumns+` FROM devices WHERE token_hash = ?`, tokenHash))
}

func (s *Store) ListDevices(ctx context.Context, userID string) ([]Device, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT `+deviceColumns+` FROM devices WHERE user_id = ? ORDER BY created_at, id`, userID)
	if err != nil {
		return nil, fmt.Errorf("list devices: %w", err)
	}
	defer rows.Close()
	var out []Device
	for rows.Next() {
		d, err := scanDevice(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

// RevokeDevice is idempotent for the owner and ErrNotFound for anyone else.
func (s *Store) RevokeDevice(ctx context.Context, userID, deviceID string) error {
	res, err := s.db.ExecContext(ctx,
		`UPDATE devices SET revoked_at = CASE WHEN revoked_at = 0 THEN ? ELSE revoked_at END WHERE id = ? AND user_id = ?`,
		s.nowMs(), deviceID, userID)
	if err != nil {
		return fmt.Errorf("revoke device: %w", err)
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *Store) TouchDevice(ctx context.Context, deviceID string) error {
	if _, err := s.db.ExecContext(ctx, `UPDATE devices SET last_seen_at = ? WHERE id = ?`, s.nowMs(), deviceID); err != nil {
		return fmt.Errorf("touch device: %w", err)
	}
	return nil
}

type KeyBundle struct {
	PublicEncKey  []byte
	PublicSignKey []byte
	Bundle        []byte // the serialized obsync.v1.KeyBundle, opaque here
	UpdatedAtMs   int64
}

func (s *Store) KeyBundle(ctx context.Context, userID string) (KeyBundle, error) {
	var kb KeyBundle
	err := s.db.QueryRowContext(ctx,
		`SELECT public_enc_key, public_sign_key, bundle, updated_at FROM key_bundles WHERE user_id = ?`, userID).
		Scan(&kb.PublicEncKey, &kb.PublicSignKey, &kb.Bundle, &kb.UpdatedAtMs)
	if errors.Is(err, sql.ErrNoRows) {
		return KeyBundle{}, ErrNotFound
	}
	if err != nil {
		return KeyBundle{}, fmt.Errorf("read key bundle: %w", err)
	}
	return kb, nil
}

// PutKeyBundle stores the first bundle, or replaces the wrapped private keys
// of an existing one (a passphrase change). Public keys never change: other
// members pin them, so a different public key is rejected.
func (s *Store) PutKeyBundle(ctx context.Context, userID string, kb KeyBundle) error {
	return s.withTx(ctx, func(tx *sql.Tx) error {
		var enc, sign []byte
		err := tx.QueryRowContext(ctx,
			`SELECT public_enc_key, public_sign_key FROM key_bundles WHERE user_id = ?`, userID).Scan(&enc, &sign)
		switch {
		case errors.Is(err, sql.ErrNoRows):
			_, err = tx.ExecContext(ctx,
				`INSERT INTO key_bundles (user_id, public_enc_key, public_sign_key, bundle, updated_at) VALUES (?, ?, ?, ?, ?)`,
				userID, kb.PublicEncKey, kb.PublicSignKey, kb.Bundle, s.nowMs())
		case err != nil:
			return fmt.Errorf("read key bundle: %w", err)
		case !bytes.Equal(enc, kb.PublicEncKey) || !bytes.Equal(sign, kb.PublicSignKey):
			return ErrKeyMismatch
		default:
			_, err = tx.ExecContext(ctx,
				`UPDATE key_bundles SET bundle = ?, updated_at = ? WHERE user_id = ?`, kb.Bundle, s.nowMs(), userID)
		}
		if err != nil {
			return fmt.Errorf("write key bundle: %w", err)
		}
		return nil
	})
}
```

Append to `server/internal/store/storetest/storetest.go`. Add `"github.com/jfms7s/obsidian-sync/server/internal/ids"` to its imports.
```go
// SeedUser creates a user with a 1 GiB quota and an unusable password hash.
func SeedUser(t testing.TB, st *store.Store, username string) store.User {
	t.Helper()
	u := store.User{ID: ids.New(), Username: username, PasswordHash: "unusable", QuotaBytes: 1 << 30}
	if err := st.CreateUser(context.Background(), u); err != nil {
		t.Fatalf("seed user: %v", err)
	}
	got, err := st.UserByID(context.Background(), u.ID)
	if err != nil {
		t.Fatalf("seed user: %v", err)
	}
	return got
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd server && go test -race ./internal/store/...`
Expected: `ok`

- [ ] **Step 5: Commit**

```bash
git add server/internal/store
git commit -m "feat(store): users, device tokens and key bundles

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Store: vaults, membership, vault keys

**Files:**
- Create: `server/internal/store/vaults.go`
- Modify: `server/internal/store/storetest/storetest.go` (add `SeedVault`)
- Test: `server/internal/store/vaults_test.go`

**Interfaces:**
- Consumes: Task 3 helpers, plus `SeedUser` (Task 4).
- Produces:
  ```go
  type Vault struct { ID, OwnerID string; EncName []byte; Seq int64; CurrentEpoch int; BytesUsed, CreatedAtMs int64 }
  type VaultKey struct { Epoch int; SealedKey []byte } // epoch 0 = naming key
  func (s *Store) CreateVault(ctx context.Context, v Vault, keys []VaultKey) error   // owner becomes member; keys stored for owner; ErrExists
  func (s *Store) ListVaults(ctx context.Context, userID string) ([]Vault, error)
  func (s *Store) VaultForMember(ctx context.Context, vaultID, userID string) (Vault, error) // ErrNotFound if absent or not a member
  func (s *Store) VaultKeys(ctx context.Context, vaultID, userID string) ([]VaultKey, error) // ordered by epoch
  func (s *Store) UsageBytes(ctx context.Context, ownerID string) (int64, error)            // sum of bytes_used over owned vaults

  // storetest
  func SeedVault(t testing.TB, st *store.Store, ownerID string) store.Vault // keys for epochs 0 and 1
  ```

- [ ] **Step 1: Write the failing tests**

`server/internal/store/vaults_test.go`:
```go
package store_test

import (
	"errors"
	"testing"

	"github.com/jfms7s/obsidian-sync/server/internal/ids"
	"github.com/jfms7s/obsidian-sync/server/internal/store"
	"github.com/jfms7s/obsidian-sync/server/internal/store/storetest"
)

func TestVaultLifecycle(t *testing.T) {
	st, clk := storetest.New(t)
	alice := storetest.SeedUser(t, st, "alice")
	bob := storetest.SeedUser(t, st, "bob")
	v := store.Vault{ID: ids.New(), OwnerID: alice.ID, EncName: []byte("enc-name")}
	keys := []store.VaultKey{{Epoch: 1, SealedKey: []byte("k1")}, {Epoch: 0, SealedKey: []byte("k0")}}
	if err := st.CreateVault(ctx, v, keys); err != nil {
		t.Fatal(err)
	}
	if err := st.CreateVault(ctx, v, keys); !errors.Is(err, store.ErrExists) {
		t.Fatalf("duplicate vault err = %v", err)
	}

	got, err := st.VaultForMember(ctx, v.ID, alice.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.OwnerID != alice.ID || string(got.EncName) != "enc-name" || got.Seq != 0 || got.CurrentEpoch != 1 || got.CreatedAtMs != clk.Now().UnixMilli() {
		t.Fatalf("got %+v", got)
	}
	if _, err := st.VaultForMember(ctx, v.ID, bob.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("non-member err = %v", err)
	}

	list, err := st.ListVaults(ctx, alice.ID)
	if err != nil || len(list) != 1 || list[0].ID != v.ID {
		t.Fatalf("list = %+v, err %v", list, err)
	}
	if list, _ := st.ListVaults(ctx, bob.ID); len(list) != 0 {
		t.Fatalf("bob sees %+v", list)
	}

	gotKeys, err := st.VaultKeys(ctx, v.ID, alice.ID)
	if err != nil || len(gotKeys) != 2 || gotKeys[0].Epoch != 0 || string(gotKeys[1].SealedKey) != "k1" {
		t.Fatalf("keys = %+v, err %v", gotKeys, err)
	}
	if used, err := st.UsageBytes(ctx, alice.ID); err != nil || used != 0 {
		t.Fatalf("usage = %d, err %v", used, err)
	}
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd server && go test ./internal/store/`
Expected: FAIL to compile with `st.CreateVault undefined`.

- [ ] **Step 3: Implement**

`server/internal/store/vaults.go`:
```go
package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
)

type Vault struct {
	ID           string
	OwnerID      string
	EncName      []byte
	Seq          int64
	CurrentEpoch int
	BytesUsed    int64
	CreatedAtMs  int64
}

type VaultKey struct {
	Epoch     int // 0 = naming key
	SealedKey []byte
}

const vaultColumns = `v.id, v.owner_id, v.enc_name, v.seq, v.current_epoch, v.bytes_used, v.created_at`

func scanVault(row rowScanner) (Vault, error) {
	var v Vault
	err := row.Scan(&v.ID, &v.OwnerID, &v.EncName, &v.Seq, &v.CurrentEpoch, &v.BytesUsed, &v.CreatedAtMs)
	if errors.Is(err, sql.ErrNoRows) {
		return Vault{}, ErrNotFound
	}
	if err != nil {
		return Vault{}, fmt.Errorf("scan vault: %w", err)
	}
	return v, nil
}

// CreateVault stores a vault at epoch 1, makes its owner the only member and
// stores the owner's sealed keys.
func (s *Store) CreateVault(ctx context.Context, v Vault, keys []VaultKey) error {
	return s.withTx(ctx, func(tx *sql.Tx) error {
		_, err := tx.ExecContext(ctx,
			`INSERT INTO vaults (id, owner_id, enc_name, seq, current_epoch, bytes_used, created_at) VALUES (?, ?, ?, 0, 1, 0, ?)`,
			v.ID, v.OwnerID, v.EncName, s.nowMs())
		if isUniqueViolation(err) {
			return ErrExists
		}
		if err != nil {
			return fmt.Errorf("create vault: %w", err)
		}
		if _, err := tx.ExecContext(ctx,
			`INSERT INTO vault_members (vault_id, user_id, role) VALUES (?, ?, 'owner')`, v.ID, v.OwnerID); err != nil {
			return fmt.Errorf("add owner: %w", err)
		}
		for _, k := range keys {
			if _, err := tx.ExecContext(ctx,
				`INSERT INTO vault_keys (vault_id, user_id, epoch, sealed_key) VALUES (?, ?, ?, ?)`,
				v.ID, v.OwnerID, k.Epoch, k.SealedKey); err != nil {
				return fmt.Errorf("store vault key: %w", err)
			}
		}
		return nil
	})
}

func (s *Store) ListVaults(ctx context.Context, userID string) ([]Vault, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT `+vaultColumns+` FROM vaults v JOIN vault_members m ON m.vault_id = v.id
		 WHERE m.user_id = ? ORDER BY v.created_at, v.id`, userID)
	if err != nil {
		return nil, fmt.Errorf("list vaults: %w", err)
	}
	defer rows.Close()
	var out []Vault
	for rows.Next() {
		v, err := scanVault(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

func (s *Store) VaultForMember(ctx context.Context, vaultID, userID string) (Vault, error) {
	return scanVault(s.db.QueryRowContext(ctx,
		`SELECT `+vaultColumns+` FROM vaults v JOIN vault_members m ON m.vault_id = v.id
		 WHERE v.id = ? AND m.user_id = ?`, vaultID, userID))
}

func (s *Store) VaultKeys(ctx context.Context, vaultID, userID string) ([]VaultKey, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT epoch, sealed_key FROM vault_keys WHERE vault_id = ? AND user_id = ? ORDER BY epoch`, vaultID, userID)
	if err != nil {
		return nil, fmt.Errorf("vault keys: %w", err)
	}
	defer rows.Close()
	var out []VaultKey
	for rows.Next() {
		var k VaultKey
		if err := rows.Scan(&k.Epoch, &k.SealedKey); err != nil {
			return nil, fmt.Errorf("scan vault key: %w", err)
		}
		out = append(out, k)
	}
	return out, rows.Err()
}

// UsageBytes is the stored chunk bytes (history included) of every vault the
// user owns. Shared vaults count against their owner.
func (s *Store) UsageBytes(ctx context.Context, ownerID string) (int64, error) {
	var n int64
	if err := s.db.QueryRowContext(ctx,
		`SELECT COALESCE(SUM(bytes_used), 0) FROM vaults WHERE owner_id = ?`, ownerID).Scan(&n); err != nil {
		return 0, fmt.Errorf("usage: %w", err)
	}
	return n, nil
}
```

Append to `server/internal/store/storetest/storetest.go`:
```go
// SeedVault creates a vault owned by ownerID with placeholder keys for epochs 0 and 1.
func SeedVault(t testing.TB, st *store.Store, ownerID string) store.Vault {
	t.Helper()
	v := store.Vault{ID: ids.New(), OwnerID: ownerID, EncName: []byte("vault-name")}
	keys := []store.VaultKey{{Epoch: 0, SealedKey: []byte("naming")}, {Epoch: 1, SealedKey: []byte("epoch-1")}}
	if err := st.CreateVault(context.Background(), v, keys); err != nil {
		t.Fatalf("seed vault: %v", err)
	}
	got, err := st.VaultForMember(context.Background(), v.ID, ownerID)
	if err != nil {
		t.Fatalf("seed vault: %v", err)
	}
	return got
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd server && go test -race ./internal/store/...`
Expected: `ok`

- [ ] **Step 5: Commit**

```bash
git add server/internal/store
git commit -m "feat(store): vaults, membership and sealed vault keys

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Store: chunks, usage accounting, user deletion

**Files:**
- Create: `server/internal/store/chunks.go`
- Modify: `server/internal/store/users.go` (add `DeleteUser`)
- Modify: `server/internal/store/storetest/storetest.go` (add `ChunkID`, `SeedChunk`)
- Test: `server/internal/store/chunks_test.go`

**Interfaces:**
- Consumes: Tasks 3–5.
- Produces:
  ```go
  type Chunk struct { VaultID string; ChunkID []byte; BlobKey string; Size int64 }
  func (s *Store) InsertChunk(ctx context.Context, c Chunk) (inserted bool, err error) // false if it already existed; adds Size to the vault's bytes_used when inserted
  func (s *Store) TouchChunks(ctx context.Context, vaultID string, chunkIDs [][]byte) ([]bool, error) // marks existing chunks recently used; reports existence
  func (s *Store) ChunkBlobKey(ctx context.Context, vaultID string, chunkID []byte) (string, error) // ErrNotFound
  func (s *Store) DeleteUser(ctx context.Context, userID string) (blobKeys []string, err error)     // removes everything the user owns; ErrNotFound

  // storetest
  func ChunkID(b byte) []byte                          // 32 bytes of b
  func SeedChunk(t testing.TB, st *store.Store, vaultID string, id []byte, size int64) // blob key "test/<hex>"
  ```
- Why the blob key is per upload: every upload writes to a fresh random blob key, and only the upload whose row insert wins keeps its blob. Garbage collection (Task 15) deletes the row first and the blob after. A re-upload racing with GC therefore always gets its own row and its own blob, and can never lose its data to a delete aimed at an older blob.

- [ ] **Step 1: Write the failing tests**

`server/internal/store/chunks_test.go`:
```go
package store_test

import (
	"errors"
	"testing"
	"time"

	"github.com/jfms7s/obsidian-sync/server/internal/store"
	"github.com/jfms7s/obsidian-sync/server/internal/store/storetest"
)

func TestInsertAndTouchChunks(t *testing.T) {
	st, _ := storetest.New(t)
	u := storetest.SeedUser(t, st, "alice")
	v := storetest.SeedVault(t, st, u.ID)

	inserted, err := st.InsertChunk(ctx, store.Chunk{VaultID: v.ID, ChunkID: storetest.ChunkID(1), BlobKey: "k1", Size: 100})
	if err != nil || !inserted {
		t.Fatalf("inserted=%v err=%v", inserted, err)
	}
	inserted, err = st.InsertChunk(ctx, store.Chunk{VaultID: v.ID, ChunkID: storetest.ChunkID(1), BlobKey: "k2", Size: 100})
	if err != nil || inserted {
		t.Fatalf("second insert inserted=%v err=%v, want false", inserted, err)
	}
	if key, _ := st.ChunkBlobKey(ctx, v.ID, storetest.ChunkID(1)); key != "k1" {
		t.Fatalf("blob key = %q, want the first upload's", key)
	}
	if used, _ := st.UsageBytes(ctx, u.ID); used != 100 {
		t.Fatalf("usage = %d, want 100 (counted once)", used)
	}

	exists, err := st.TouchChunks(ctx, v.ID, [][]byte{storetest.ChunkID(1), storetest.ChunkID(2)})
	if err != nil || !exists[0] || exists[1] {
		t.Fatalf("exists = %v, err %v", exists, err)
	}
	if _, err := st.ChunkBlobKey(ctx, v.ID, storetest.ChunkID(2)); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("err = %v", err)
	}
}

func TestChunksAreScopedToTheirVault(t *testing.T) {
	st, _ := storetest.New(t)
	u := storetest.SeedUser(t, st, "alice")
	v1 := storetest.SeedVault(t, st, u.ID)
	v2 := storetest.SeedVault(t, st, u.ID)
	storetest.SeedChunk(t, st, v1.ID, storetest.ChunkID(1), 10)
	if exists, _ := st.TouchChunks(ctx, v2.ID, [][]byte{storetest.ChunkID(1)}); exists[0] {
		t.Fatal("chunk leaked into another vault")
	}
}

func TestDeleteUserRemovesEverythingAndReturnsBlobKeys(t *testing.T) {
	st, clk := storetest.New(t)
	alice := storetest.SeedUser(t, st, "alice")
	bob := storetest.SeedUser(t, st, "bob")
	av := storetest.SeedVault(t, st, alice.ID)
	bv := storetest.SeedVault(t, st, bob.ID)
	storetest.SeedChunk(t, st, av.ID, storetest.ChunkID(1), 10)
	storetest.SeedChunk(t, st, bv.ID, storetest.ChunkID(2), 10)
	clk.Advance(time.Second)

	keys, err := st.DeleteUser(ctx, alice.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(keys) != 1 || keys[0] != "test/"+hexOf(storetest.ChunkID(1)) {
		t.Fatalf("blob keys = %v", keys)
	}
	if _, err := st.UserByID(ctx, alice.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("user still there: %v", err)
	}
	if _, err := st.VaultForMember(ctx, av.ID, alice.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("vault still there: %v", err)
	}
	if exists, _ := st.TouchChunks(ctx, bv.ID, [][]byte{storetest.ChunkID(2)}); !exists[0] {
		t.Fatal("bob's chunk was deleted")
	}
	if _, err := st.DeleteUser(ctx, alice.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("second delete err = %v", err)
	}
}
```

Add this helper at the bottom of `chunks_test.go`, and add `"encoding/hex"` to its imports:
```go
func hexOf(b []byte) string { return hex.EncodeToString(b) }
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd server && go test ./internal/store/`
Expected: FAIL to compile with `st.InsertChunk undefined`.

- [ ] **Step 3: Implement**

`server/internal/store/chunks.go`:
```go
package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
)

type Chunk struct {
	VaultID string
	ChunkID []byte
	BlobKey string // unique per upload, see Task 6 notes
	Size    int64  // ciphertext bytes
}

// InsertChunk records an uploaded chunk and adds its size to the vault's
// usage. It returns false when the chunk was already recorded; the caller
// must then delete the blob it just wrote.
func (s *Store) InsertChunk(ctx context.Context, c Chunk) (bool, error) {
	var inserted bool
	err := s.withTx(ctx, func(tx *sql.Tx) error {
		res, err := tx.ExecContext(ctx,
			`INSERT OR IGNORE INTO chunks (vault_id, chunk_id, blob_key, size, touched_at) VALUES (?, ?, ?, ?, ?)`,
			c.VaultID, c.ChunkID, c.BlobKey, c.Size, s.nowMs())
		if err != nil {
			return fmt.Errorf("insert chunk: %w", err)
		}
		if n, _ := res.RowsAffected(); n == 0 {
			return nil
		}
		inserted = true
		if _, err := tx.ExecContext(ctx,
			`UPDATE vaults SET bytes_used = bytes_used + ? WHERE id = ?`, c.Size, c.VaultID); err != nil {
			return fmt.Errorf("add usage: %w", err)
		}
		return nil
	})
	return inserted, err
}

// TouchChunks reports which chunks exist and refreshes their touched_at, so
// garbage collection leaves them alone while the client commits.
func (s *Store) TouchChunks(ctx context.Context, vaultID string, chunkIDs [][]byte) ([]bool, error) {
	exists := make([]bool, len(chunkIDs))
	err := s.withTx(ctx, func(tx *sql.Tx) error {
		now := s.nowMs()
		for i, id := range chunkIDs {
			res, err := tx.ExecContext(ctx,
				`UPDATE chunks SET touched_at = ? WHERE vault_id = ? AND chunk_id = ?`, now, vaultID, id)
			if err != nil {
				return fmt.Errorf("touch chunk: %w", err)
			}
			n, _ := res.RowsAffected()
			exists[i] = n == 1
		}
		return nil
	})
	return exists, err
}

func (s *Store) ChunkBlobKey(ctx context.Context, vaultID string, chunkID []byte) (string, error) {
	var key string
	err := s.db.QueryRowContext(ctx,
		`SELECT blob_key FROM chunks WHERE vault_id = ? AND chunk_id = ?`, vaultID, chunkID).Scan(&key)
	if errors.Is(err, sql.ErrNoRows) {
		return "", ErrNotFound
	}
	if err != nil {
		return "", fmt.Errorf("chunk blob key: %w", err)
	}
	return key, nil
}
```

Append to `server/internal/store/users.go`:
```go
// DeleteUser removes the user, their devices and key bundle, every vault they
// own with all of its contents, and their membership of other vaults. It
// returns the blob keys of the deleted chunks so the caller can delete the
// blobs.
func (s *Store) DeleteUser(ctx context.Context, userID string) ([]string, error) {
	var blobKeys []string
	err := s.withTx(ctx, func(tx *sql.Tx) error {
		rows, err := tx.QueryContext(ctx,
			`SELECT blob_key FROM chunks WHERE vault_id IN (SELECT id FROM vaults WHERE owner_id = ?)`, userID)
		if err != nil {
			return fmt.Errorf("list blobs: %w", err)
		}
		for rows.Next() {
			var k string
			if err := rows.Scan(&k); err != nil {
				rows.Close()
				return fmt.Errorf("scan blob key: %w", err)
			}
			blobKeys = append(blobKeys, k)
		}
		if err := rows.Close(); err != nil {
			return err
		}

		const owned = `(SELECT id FROM vaults WHERE owner_id = ?)`
		for _, stmt := range []string{
			`DELETE FROM version_chunks WHERE vault_id IN ` + owned,
			`DELETE FROM versions WHERE vault_id IN ` + owned,
			`DELETE FROM files WHERE vault_id IN ` + owned,
			`DELETE FROM chunks WHERE vault_id IN ` + owned,
			`DELETE FROM vault_keys WHERE vault_id IN ` + owned,
			`DELETE FROM vault_members WHERE vault_id IN ` + owned,
			`DELETE FROM vaults WHERE owner_id = ?`,
			`DELETE FROM vault_keys WHERE user_id = ?`,
			`DELETE FROM vault_members WHERE user_id = ?`,
			`DELETE FROM devices WHERE user_id = ?`,
			`DELETE FROM key_bundles WHERE user_id = ?`,
		} {
			if _, err := tx.ExecContext(ctx, stmt, userID); err != nil {
				return fmt.Errorf("delete user data: %w", err)
			}
		}
		res, err := tx.ExecContext(ctx, `DELETE FROM users WHERE id = ?`, userID)
		if err != nil {
			return fmt.Errorf("delete user: %w", err)
		}
		if n, _ := res.RowsAffected(); n == 0 {
			return ErrNotFound
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return blobKeys, nil
}
```

Append to `server/internal/store/storetest/storetest.go`. Add `"bytes"` and `"encoding/hex"` to its imports.
```go
// ChunkID returns a 32-byte id filled with b.
func ChunkID(b byte) []byte { return bytes.Repeat([]byte{b}, 32) }

// SeedChunk records a chunk row with blob key "test/<hex id>" (no blob is written).
func SeedChunk(t testing.TB, st *store.Store, vaultID string, id []byte, size int64) {
	t.Helper()
	c := store.Chunk{VaultID: vaultID, ChunkID: id, BlobKey: "test/" + hex.EncodeToString(id), Size: size}
	if _, err := st.InsertChunk(context.Background(), c); err != nil {
		t.Fatalf("seed chunk: %v", err)
	}
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd server && go test -race ./internal/store/...`
Expected: `ok`

- [ ] **Step 5: Commit**

```bash
git add server/internal/store
git commit -m "feat(store): chunk records, usage accounting and user deletion

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Store: the change log (commit, changes, heads, history, trash)

**Files:**
- Create: `server/internal/store/sync.go`
- Modify: `server/internal/store/storetest/storetest.go` (add `FileID`, `NewVersion`, `MustCommit`)
- Test: `server/internal/store/sync_test.go`

**Interfaces:**
- Consumes: Tasks 3–6.
- Produces:
  ```go
  type Version struct {
      VaultID string
      FileID, VersionID, BaseVersionID []byte // BaseVersionID nil/empty = new file
      Epoch int
      EncMeta []byte
      ChunkIDs [][]byte
      Size int64
      Deleted bool
      DeviceID string
      CreatedAtMs, Seq int64 // set by the store
  }
  type CommitReason int
  const ( CommitOK CommitReason = iota; CommitConflict; CommitStaleEpoch; CommitMissingChunk; CommitInvalid )
  type CommitOutcome struct { Reason CommitReason; Seq int64; HeadVersionID []byte; Detail string }
  func (o CommitOutcome) OK() bool
  func (s *Store) Commit(ctx context.Context, v Version) (CommitOutcome, error)  // error only for infrastructure failures or ErrNotFound (vault)
  func (s *Store) Changes(ctx context.Context, vaultID string, since int64, limit int) ([]Version, error) // seq > since, ascending
  type Head struct { FileID, VersionID []byte; Seq int64; Deleted bool }
  func (s *Store) Heads(ctx context.Context, vaultID string, after []byte, limit int) ([]Head, error)   // file_id > after, ascending
  func (s *Store) History(ctx context.Context, vaultID string, fileID []byte) ([]Version, error)        // newest first
  func (s *Store) Trash(ctx context.Context, vaultID string) ([]Version, error)                         // tombstone heads, newest first

  // storetest
  func FileID(b byte) []byte
  func NewVersion(vaultID string, fileID, base []byte, chunks ...[]byte) store.Version // epoch 1, enc_meta "meta", device "dev"
  func MustCommit(t testing.TB, st *store.Store, v store.Version) store.Version        // returns v with Seq set
  ```
- Commit rules, in order:
  1. If the same `version_id` is already stored for the same file, return OK with its original seq. That makes retries idempotent.
  2. If the same `version_id` is stored for a different file, return Invalid.
  3. If the vault doesn't exist, return `ErrNotFound`.
  4. If the commit's epoch isn't the vault's current epoch, return StaleEpoch.
  5. If the file's head isn't the commit's base (no file row counts as an empty head), return Conflict carrying the head.
  6. If it's a deletion of a file the server doesn't have, return Invalid.
  7. If any referenced chunk is missing, return MissingChunk.
  8. Otherwise, increment the vault's seq, insert the version and its chunk references, and set the file's head.

- [ ] **Step 1: Write the failing tests**

`server/internal/store/sync_test.go`:
```go
package store_test

import (
	"bytes"
	"sync"
	"testing"

	"github.com/jfms7s/obsidian-sync/server/internal/store"
	"github.com/jfms7s/obsidian-sync/server/internal/store/storetest"
)

type fixture struct {
	st    *store.Store
	clk   *storetest.Clock
	vault store.Vault
}

func newFixture(t *testing.T) fixture {
	st, clk := storetest.New(t)
	u := storetest.SeedUser(t, st, "alice")
	v := storetest.SeedVault(t, st, u.ID)
	for b := byte(1); b <= 4; b++ {
		storetest.SeedChunk(t, st, v.ID, storetest.ChunkID(b), 10)
	}
	return fixture{st: st, clk: clk, vault: v}
}

func TestCommitCreateThenUpdate(t *testing.T) {
	f := newFixture(t)
	v1 := storetest.MustCommit(t, f.st, storetest.NewVersion(f.vault.ID, storetest.FileID(1), nil, storetest.ChunkID(1), storetest.ChunkID(2)))
	if v1.Seq != 1 {
		t.Fatalf("seq = %d", v1.Seq)
	}
	v2 := storetest.MustCommit(t, f.st, storetest.NewVersion(f.vault.ID, storetest.FileID(1), v1.VersionID, storetest.ChunkID(3)))
	if v2.Seq != 2 {
		t.Fatalf("seq = %d", v2.Seq)
	}

	changes, err := f.st.Changes(ctx, f.vault.ID, 0, 10)
	if err != nil || len(changes) != 2 {
		t.Fatalf("changes = %+v, err %v", changes, err)
	}
	c := changes[0]
	if !bytes.Equal(c.VersionID, v1.VersionID) || c.Seq != 1 || len(c.ChunkIDs) != 2 ||
		!bytes.Equal(c.ChunkIDs[0], storetest.ChunkID(1)) || !bytes.Equal(c.ChunkIDs[1], storetest.ChunkID(2)) ||
		c.BaseVersionID != nil || c.DeviceID != "dev" || c.Epoch != 1 || string(c.EncMeta) != "meta" {
		t.Fatalf("first change = %+v", c)
	}
	if !bytes.Equal(changes[1].BaseVersionID, v1.VersionID) {
		t.Fatalf("second change base = %x", changes[1].BaseVersionID)
	}
}

func TestCommitConflictReturnsHead(t *testing.T) {
	f := newFixture(t)
	v1 := storetest.MustCommit(t, f.st, storetest.NewVersion(f.vault.ID, storetest.FileID(1), nil, storetest.ChunkID(1)))

	// Someone else also thinks the file is new.
	out, err := f.st.Commit(ctx, storetest.NewVersion(f.vault.ID, storetest.FileID(1), nil, storetest.ChunkID(2)))
	if err != nil || out.Reason != store.CommitConflict || !bytes.Equal(out.HeadVersionID, v1.VersionID) {
		t.Fatalf("out = %+v, err %v", out, err)
	}
	// A base that does not exist on the server, for a file the server lacks.
	out, _ = f.st.Commit(ctx, storetest.NewVersion(f.vault.ID, storetest.FileID(2), bytes.Repeat([]byte{7}, 16)))
	if out.Reason != store.CommitConflict || out.HeadVersionID != nil {
		t.Fatalf("out = %+v", out)
	}
}

func TestCommitRetryIsIdempotent(t *testing.T) {
	f := newFixture(t)
	v := storetest.NewVersion(f.vault.ID, storetest.FileID(1), nil, storetest.ChunkID(1))
	first := storetest.MustCommit(t, f.st, v)
	again, err := f.st.Commit(ctx, v)
	if err != nil || !again.OK() || again.Seq != first.Seq {
		t.Fatalf("retry = %+v, err %v; want OK with seq %d", again, err, first.Seq)
	}
	if changes, _ := f.st.Changes(ctx, f.vault.ID, 0, 10); len(changes) != 1 {
		t.Fatalf("retry created a second version: %d changes", len(changes))
	}
	// The same version id on another file is a client bug, not a retry.
	other := v
	other.FileID = storetest.FileID(2)
	if out, _ := f.st.Commit(ctx, other); out.Reason != store.CommitInvalid {
		t.Fatalf("out = %+v", out)
	}
}

func TestCommitRejections(t *testing.T) {
	f := newFixture(t)

	missing := storetest.NewVersion(f.vault.ID, storetest.FileID(1), nil, storetest.ChunkID(9))
	if out, _ := f.st.Commit(ctx, missing); out.Reason != store.CommitMissingChunk {
		t.Fatalf("missing chunk: %+v", out)
	}

	stale := storetest.NewVersion(f.vault.ID, storetest.FileID(1), nil, storetest.ChunkID(1))
	stale.Epoch = 2
	if out, _ := f.st.Commit(ctx, stale); out.Reason != store.CommitStaleEpoch {
		t.Fatalf("stale epoch: %+v", out)
	}

	tombstone := storetest.NewVersion(f.vault.ID, storetest.FileID(3), nil)
	tombstone.Deleted = true
	if out, _ := f.st.Commit(ctx, tombstone); out.Reason != store.CommitInvalid {
		t.Fatalf("delete of unknown file: %+v", out)
	}

	if v, _ := f.st.VaultForMember(ctx, f.vault.ID, f.vault.OwnerID); v.Seq != 0 {
		t.Fatalf("rejected commits advanced seq to %d", v.Seq)
	}
}

func TestConcurrentCreatesOfOneFileHaveOneWinner(t *testing.T) {
	f := newFixture(t)
	const n = 20
	outcomes := make([]store.CommitOutcome, n)
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			out, err := f.st.Commit(ctx, storetest.NewVersion(f.vault.ID, storetest.FileID(1), nil, storetest.ChunkID(1)))
			if err != nil {
				t.Error(err)
			}
			outcomes[i] = out
		}(i)
	}
	wg.Wait()
	ok := 0
	for _, o := range outcomes {
		switch o.Reason {
		case store.CommitOK:
			ok++
		case store.CommitConflict:
		default:
			t.Fatalf("unexpected outcome %+v", o)
		}
	}
	if ok != 1 {
		t.Fatalf("%d winners, want 1", ok)
	}
}

func TestConcurrentCommitsGetGaplessSeqs(t *testing.T) {
	f := newFixture(t)
	const n = 20
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			if out, err := f.st.Commit(ctx, storetest.NewVersion(f.vault.ID, storetest.FileID(byte(10+i)), nil)); err != nil || !out.OK() {
				t.Errorf("out %+v err %v", out, err)
			}
		}(i)
	}
	wg.Wait()
	changes, err := f.st.Changes(ctx, f.vault.ID, 0, 100)
	if err != nil || len(changes) != n {
		t.Fatalf("changes = %d, err %v", len(changes), err)
	}
	for i, c := range changes {
		if c.Seq != int64(i+1) {
			t.Fatalf("change %d has seq %d", i, c.Seq)
		}
	}
}

func TestChangesSince(t *testing.T) {
	f := newFixture(t)
	for b := byte(1); b <= 3; b++ {
		storetest.MustCommit(t, f.st, storetest.NewVersion(f.vault.ID, storetest.FileID(b), nil))
	}
	page, _ := f.st.Changes(ctx, f.vault.ID, 1, 10)
	if len(page) != 2 || page[0].Seq != 2 {
		t.Fatalf("page = %+v", page)
	}
	if page, _ := f.st.Changes(ctx, f.vault.ID, 3, 10); len(page) != 0 {
		t.Fatalf("since == vault seq must be empty, got %d", len(page))
	}
	if page, _ := f.st.Changes(ctx, f.vault.ID, 0, 2); len(page) != 2 || page[1].Seq != 2 {
		t.Fatalf("limit not applied: %+v", page)
	}
}

func TestHeadsPaging(t *testing.T) {
	f := newFixture(t)
	for b := byte(1); b <= 4; b++ {
		storetest.MustCommit(t, f.st, storetest.NewVersion(f.vault.ID, storetest.FileID(b), nil))
	}
	first, err := f.st.Heads(ctx, f.vault.ID, nil, 2)
	if err != nil || len(first) != 2 || !bytes.Equal(first[0].FileID, storetest.FileID(1)) {
		t.Fatalf("first = %+v, err %v", first, err)
	}
	second, _ := f.st.Heads(ctx, f.vault.ID, first[1].FileID, 2)
	if len(second) != 2 || !bytes.Equal(second[1].FileID, storetest.FileID(4)) {
		t.Fatalf("second = %+v", second)
	}
	if third, _ := f.st.Heads(ctx, f.vault.ID, second[1].FileID, 2); len(third) != 0 {
		t.Fatalf("third page = %+v, want empty", third)
	}
}

func TestHistoryAndTrash(t *testing.T) {
	f := newFixture(t)
	v1 := storetest.MustCommit(t, f.st, storetest.NewVersion(f.vault.ID, storetest.FileID(1), nil, storetest.ChunkID(1)))
	v2 := storetest.MustCommit(t, f.st, storetest.NewVersion(f.vault.ID, storetest.FileID(1), v1.VersionID, storetest.ChunkID(2)))
	tomb := storetest.NewVersion(f.vault.ID, storetest.FileID(1), v2.VersionID)
	tomb.Deleted = true
	tomb = storetest.MustCommit(t, f.st, tomb)
	storetest.MustCommit(t, f.st, storetest.NewVersion(f.vault.ID, storetest.FileID(2), nil))

	hist, err := f.st.History(ctx, f.vault.ID, storetest.FileID(1))
	if err != nil || len(hist) != 3 || !hist[0].Deleted || hist[2].Seq != 1 || len(hist[1].ChunkIDs) != 1 {
		t.Fatalf("history = %+v, err %v", hist, err)
	}
	trash, err := f.st.Trash(ctx, f.vault.ID)
	if err != nil || len(trash) != 1 || !bytes.Equal(trash[0].VersionID, tomb.VersionID) {
		t.Fatalf("trash = %+v, err %v", trash, err)
	}
	heads, _ := f.st.Heads(ctx, f.vault.ID, nil, 10)
	if len(heads) != 2 || !heads[0].Deleted || heads[1].Deleted {
		t.Fatalf("heads = %+v", heads)
	}

	// Re-creating a deleted file uses the tombstone as its base.
	storetest.MustCommit(t, f.st, storetest.NewVersion(f.vault.ID, storetest.FileID(1), tomb.VersionID, storetest.ChunkID(3)))
	if trash, _ := f.st.Trash(ctx, f.vault.ID); len(trash) != 0 {
		t.Fatalf("restored file still in trash: %+v", trash)
	}
}
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd server && go test ./internal/store/`
Expected: FAIL to compile with `storetest.MustCommit undefined`.

- [ ] **Step 3: Implement**

`server/internal/store/sync.go`:
```go
package store

import (
	"bytes"
	"context"
	"database/sql"
	"errors"
	"fmt"
)

type Version struct {
	VaultID       string
	FileID        []byte
	VersionID     []byte
	BaseVersionID []byte // nil = the client believes the file is new
	Epoch         int
	EncMeta       []byte
	ChunkIDs      [][]byte
	Size          int64
	Deleted       bool
	DeviceID      string
	CreatedAtMs   int64
	Seq           int64
}

type CommitReason int

const (
	CommitOK CommitReason = iota
	CommitConflict
	CommitStaleEpoch
	CommitMissingChunk
	CommitInvalid
)

type CommitOutcome struct {
	Reason        CommitReason
	Seq           int64  // with CommitOK
	HeadVersionID []byte // with CommitConflict: the current head, nil if the file does not exist
	Detail        string // with CommitInvalid
}

func (o CommitOutcome) OK() bool { return o.Reason == CommitOK }

// Commit applies one version under optimistic concurrency. Rejections are
// returned as an outcome; the error is only for infrastructure failures and
// ErrNotFound when the vault does not exist.
func (s *Store) Commit(ctx context.Context, v Version) (CommitOutcome, error) {
	var out CommitOutcome
	err := s.withTx(ctx, func(tx *sql.Tx) error {
		var err error
		out, err = commitTx(ctx, tx, v, s.nowMs())
		return err
	})
	return out, err
}

func commitTx(ctx context.Context, tx *sql.Tx, v Version, now int64) (CommitOutcome, error) {
	var prevFile []byte
	var prevSeq int64
	err := tx.QueryRowContext(ctx,
		`SELECT file_id, seq FROM versions WHERE vault_id = ? AND version_id = ?`, v.VaultID, v.VersionID).
		Scan(&prevFile, &prevSeq)
	switch {
	case err == nil && bytes.Equal(prevFile, v.FileID):
		// A retry of a commit that already succeeded but whose response was lost.
		return CommitOutcome{Reason: CommitOK, Seq: prevSeq}, nil
	case err == nil:
		return CommitOutcome{Reason: CommitInvalid, Detail: "version_id is already used by another file"}, nil
	case !errors.Is(err, sql.ErrNoRows):
		return CommitOutcome{}, fmt.Errorf("look up version: %w", err)
	}

	var epoch int
	err = tx.QueryRowContext(ctx, `SELECT current_epoch FROM vaults WHERE id = ?`, v.VaultID).Scan(&epoch)
	if errors.Is(err, sql.ErrNoRows) {
		return CommitOutcome{}, ErrNotFound
	}
	if err != nil {
		return CommitOutcome{}, fmt.Errorf("read vault: %w", err)
	}
	if v.Epoch != epoch {
		return CommitOutcome{Reason: CommitStaleEpoch}, nil
	}

	var head []byte
	err = tx.QueryRowContext(ctx,
		`SELECT head_version_id FROM files WHERE vault_id = ? AND file_id = ?`, v.VaultID, v.FileID).Scan(&head)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return CommitOutcome{}, fmt.Errorf("read head: %w", err)
	}
	fileExists := err == nil
	if !bytes.Equal(head, v.BaseVersionID) {
		return CommitOutcome{Reason: CommitConflict, HeadVersionID: head}, nil
	}
	if !fileExists && v.Deleted {
		return CommitOutcome{Reason: CommitInvalid, Detail: "cannot delete a file the server does not have"}, nil
	}
	for _, id := range v.ChunkIDs {
		var one int
		err := tx.QueryRowContext(ctx,
			`SELECT 1 FROM chunks WHERE vault_id = ? AND chunk_id = ?`, v.VaultID, id).Scan(&one)
		if errors.Is(err, sql.ErrNoRows) {
			return CommitOutcome{Reason: CommitMissingChunk}, nil
		}
		if err != nil {
			return CommitOutcome{}, fmt.Errorf("check chunk: %w", err)
		}
	}

	var seq int64
	if err := tx.QueryRowContext(ctx,
		`UPDATE vaults SET seq = seq + 1 WHERE id = ? RETURNING seq`, v.VaultID).Scan(&seq); err != nil {
		return CommitOutcome{}, fmt.Errorf("advance seq: %w", err)
	}
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO versions (vault_id, version_id, file_id, base_version_id, epoch, enc_meta, size, deleted, device_id, created_at, seq)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		v.VaultID, v.VersionID, v.FileID, nonNil(v.BaseVersionID), v.Epoch, v.EncMeta, v.Size, boolInt(v.Deleted),
		v.DeviceID, now, seq); err != nil {
		return CommitOutcome{}, fmt.Errorf("insert version: %w", err)
	}
	for i, id := range v.ChunkIDs {
		if _, err := tx.ExecContext(ctx,
			`INSERT INTO version_chunks (vault_id, version_id, idx, chunk_id) VALUES (?, ?, ?, ?)`,
			v.VaultID, v.VersionID, i, id); err != nil {
			return CommitOutcome{}, fmt.Errorf("insert chunk ref: %w", err)
		}
	}
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO files (vault_id, file_id, head_version_id) VALUES (?, ?, ?)
		 ON CONFLICT (vault_id, file_id) DO UPDATE SET head_version_id = excluded.head_version_id`,
		v.VaultID, v.FileID, v.VersionID); err != nil {
		return CommitOutcome{}, fmt.Errorf("set head: %w", err)
	}
	return CommitOutcome{Reason: CommitOK, Seq: seq}, nil
}

// versionQuery joins a version subquery (which must select every versions
// column) with its chunk references, one row per chunk.
const versionQuery = `SELECT v.version_id, v.file_id, v.base_version_id, v.epoch, v.enc_meta, v.size, v.deleted,
       v.device_id, v.created_at, v.seq, vc.chunk_id
FROM (%s) v
LEFT JOIN version_chunks vc ON vc.vault_id = v.vault_id AND vc.version_id = v.version_id
ORDER BY %s, vc.idx`

func (s *Store) queryVersions(ctx context.Context, vaultID, inner, order string, args ...any) ([]Version, error) {
	rows, err := s.db.QueryContext(ctx, fmt.Sprintf(versionQuery, inner, order), args...)
	if err != nil {
		return nil, fmt.Errorf("query versions: %w", err)
	}
	defer rows.Close()
	var out []Version
	for rows.Next() {
		var v Version
		var deleted int64
		var chunkID []byte
		if err := rows.Scan(&v.VersionID, &v.FileID, &v.BaseVersionID, &v.Epoch, &v.EncMeta, &v.Size, &deleted,
			&v.DeviceID, &v.CreatedAtMs, &v.Seq, &chunkID); err != nil {
			return nil, fmt.Errorf("scan version: %w", err)
		}
		if n := len(out); n > 0 && bytes.Equal(out[n-1].VersionID, v.VersionID) {
			out[n-1].ChunkIDs = append(out[n-1].ChunkIDs, chunkID)
			continue
		}
		v.VaultID = vaultID
		v.Deleted = deleted != 0
		if len(v.BaseVersionID) == 0 {
			v.BaseVersionID = nil
		}
		if chunkID != nil {
			v.ChunkIDs = [][]byte{chunkID}
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

// Changes returns up to limit versions with seq > since, oldest first.
func (s *Store) Changes(ctx context.Context, vaultID string, since int64, limit int) ([]Version, error) {
	return s.queryVersions(ctx, vaultID,
		`SELECT * FROM versions WHERE vault_id = ? AND seq > ? ORDER BY seq LIMIT ?`, "v.seq",
		vaultID, since, limit)
}

// History returns every retained version of one file, newest first.
func (s *Store) History(ctx context.Context, vaultID string, fileID []byte) ([]Version, error) {
	return s.queryVersions(ctx, vaultID,
		`SELECT * FROM versions WHERE vault_id = ? AND file_id = ?`, "v.seq DESC",
		vaultID, fileID)
}

// Trash returns the tombstone heads of deleted files, newest first.
func (s *Store) Trash(ctx context.Context, vaultID string) ([]Version, error) {
	return s.queryVersions(ctx, vaultID,
		`SELECT ver.* FROM versions ver
		 JOIN files f ON f.vault_id = ver.vault_id AND f.head_version_id = ver.version_id
		 WHERE ver.vault_id = ? AND ver.deleted = 1`, "v.seq DESC",
		vaultID)
}

type Head struct {
	FileID    []byte
	VersionID []byte
	Seq       int64
	Deleted   bool
}

// Heads pages through every file's head in file_id order, starting after
// `after` (nil = from the start).
func (s *Store) Heads(ctx context.Context, vaultID string, after []byte, limit int) ([]Head, error) {
	q := `SELECT f.file_id, f.head_version_id, v.seq, v.deleted FROM files f
	      JOIN versions v ON v.vault_id = f.vault_id AND v.version_id = f.head_version_id
	      WHERE f.vault_id = ?`
	args := []any{vaultID}
	if len(after) > 0 {
		q += ` AND f.file_id > ?`
		args = append(args, after)
	}
	q += ` ORDER BY f.file_id LIMIT ?`
	args = append(args, limit)

	rows, err := s.db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, fmt.Errorf("heads: %w", err)
	}
	defer rows.Close()
	var out []Head
	for rows.Next() {
		var h Head
		var deleted int64
		if err := rows.Scan(&h.FileID, &h.VersionID, &h.Seq, &deleted); err != nil {
			return nil, fmt.Errorf("scan head: %w", err)
		}
		h.Deleted = deleted != 0
		out = append(out, h)
	}
	return out, rows.Err()
}
```

Append to `server/internal/store/storetest/storetest.go`:
```go
// FileID returns a 32-byte id filled with b.
func FileID(b byte) []byte { return bytes.Repeat([]byte{b}, 32) }

// NewVersion builds a commit at epoch 1 from device "dev" with a fresh version id.
func NewVersion(vaultID string, fileID, base []byte, chunks ...[]byte) store.Version {
	return store.Version{
		VaultID:       vaultID,
		FileID:        fileID,
		VersionID:     ids.Bytes(16),
		BaseVersionID: base,
		Epoch:         1,
		EncMeta:       []byte("meta"),
		ChunkIDs:      chunks,
		Size:          int64(len(chunks)),
		DeviceID:      "dev",
	}
}

// MustCommit commits v and fails the test unless it is accepted.
func MustCommit(t testing.TB, st *store.Store, v store.Version) store.Version {
	t.Helper()
	out, err := st.Commit(context.Background(), v)
	if err != nil || !out.OK() {
		t.Fatalf("commit: err=%v outcome=%+v", err, out)
	}
	v.Seq = out.Seq
	return v
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd server && go test -race ./internal/store/...`
Expected: `ok`

- [ ] **Step 5: Commit**

```bash
git add server/internal/store
git commit -m "feat(store): per-vault change log with optimistic concurrency

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 8: Blob storage (interface, contract suite, local filesystem)

**Files:**
- Create: `server/internal/blob/blob.go`, `server/internal/blob/fs.go`
- Create: `server/internal/blob/blobtest/contract.go`
- Test: `server/internal/blob/fs_test.go`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```go
  type Store interface {
      Put(ctx context.Context, key string, r io.Reader) error   // atomic: readers never see a partial blob
      Get(ctx context.Context, key string) (io.ReadCloser, error) // ErrNotFound
      Delete(ctx context.Context, key string) error              // missing key is not an error
      Ping(ctx context.Context) error
  }
  var ErrNotFound error
  func ValidKey(key string) bool // ^[a-z0-9]+(/[a-z0-9]+)*$
  func NewFS(root string) (*FS, error)
  // blobtest
  func Run(t *testing.T, newStore func(t *testing.T) blob.Store)
  ```
- The S3 implementation in sub-project 5 must pass the same `blobtest.Run` suite.

- [ ] **Step 1: Write the contract suite and the failing test**

`server/internal/blob/blobtest/contract.go`:
```go
// Package blobtest is the behaviour every blob.Store implementation must have.
package blobtest

import (
	"bytes"
	"context"
	"errors"
	"io"
	"testing"

	"github.com/jfms7s/obsidian-sync/server/internal/blob"
)

func Run(t *testing.T, newStore func(t *testing.T) blob.Store) {
	ctx := context.Background()

	t.Run("put then get", func(t *testing.T) {
		s := newStore(t)
		if err := s.Put(ctx, "v1/ab/abcd", bytes.NewReader([]byte("hello"))); err != nil {
			t.Fatal(err)
		}
		if got := read(t, s, "v1/ab/abcd"); got != "hello" {
			t.Fatalf("got %q", got)
		}
	})

	t.Run("put overwrites", func(t *testing.T) {
		s := newStore(t)
		_ = s.Put(ctx, "k", bytes.NewReader([]byte("one")))
		if err := s.Put(ctx, "k", bytes.NewReader([]byte("two"))); err != nil {
			t.Fatal(err)
		}
		if got := read(t, s, "k"); got != "two" {
			t.Fatalf("got %q", got)
		}
	})

	t.Run("get missing", func(t *testing.T) {
		s := newStore(t)
		if _, err := s.Get(ctx, "nope"); !errors.Is(err, blob.ErrNotFound) {
			t.Fatalf("err = %v", err)
		}
	})

	t.Run("delete is idempotent", func(t *testing.T) {
		s := newStore(t)
		_ = s.Put(ctx, "k", bytes.NewReader([]byte("x")))
		if err := s.Delete(ctx, "k"); err != nil {
			t.Fatal(err)
		}
		if err := s.Delete(ctx, "k"); err != nil {
			t.Fatalf("second delete: %v", err)
		}
		if _, err := s.Get(ctx, "k"); !errors.Is(err, blob.ErrNotFound) {
			t.Fatalf("err = %v", err)
		}
	})

	t.Run("failed put leaves nothing", func(t *testing.T) {
		s := newStore(t)
		err := s.Put(ctx, "k", io.MultiReader(bytes.NewReader([]byte("partial")), failingReader{}))
		if err == nil {
			t.Fatal("expected the reader's error")
		}
		if _, err := s.Get(ctx, "k"); !errors.Is(err, blob.ErrNotFound) {
			t.Fatalf("partial blob visible: %v", err)
		}
	})

	t.Run("invalid keys are rejected", func(t *testing.T) {
		s := newStore(t)
		for _, key := range []string{"", "../escape", "a//b", "UPPER", "a/", "/a"} {
			if err := s.Put(ctx, key, bytes.NewReader(nil)); err == nil {
				t.Errorf("Put(%q) succeeded", key)
			}
		}
	})

	t.Run("ping", func(t *testing.T) {
		if err := newStore(t).Ping(ctx); err != nil {
			t.Fatal(err)
		}
	})
}

type failingReader struct{}

func (failingReader) Read([]byte) (int, error) { return 0, errors.New("connection reset") }

func read(t *testing.T, s blob.Store, key string) string {
	t.Helper()
	rc, err := s.Get(context.Background(), key)
	if err != nil {
		t.Fatal(err)
	}
	defer rc.Close()
	b, err := io.ReadAll(rc)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}
```

`server/internal/blob/fs_test.go`:
```go
package blob_test

import (
	"testing"

	"github.com/jfms7s/obsidian-sync/server/internal/blob"
	"github.com/jfms7s/obsidian-sync/server/internal/blob/blobtest"
)

func TestFS(t *testing.T) {
	blobtest.Run(t, func(t *testing.T) blob.Store {
		s, err := blob.NewFS(t.TempDir())
		if err != nil {
			t.Fatal(err)
		}
		return s
	})
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd server && go test ./internal/blob/...`
Expected: FAIL because package `blob` does not exist.

- [ ] **Step 3: Implement**

`server/internal/blob/blob.go`:
```go
// Package blob stores encrypted chunk bytes under opaque keys.
package blob

import (
	"context"
	"errors"
	"io"
	"regexp"
)

var ErrNotFound = errors.New("blob: not found")

type Store interface {
	// Put stores r under key atomically; a failed Put leaves no blob behind.
	Put(ctx context.Context, key string, r io.Reader) error
	Get(ctx context.Context, key string) (io.ReadCloser, error)
	// Delete removes key; deleting a missing key is not an error.
	Delete(ctx context.Context, key string) error
	Ping(ctx context.Context) error
}

var validKey = regexp.MustCompile(`^[a-z0-9]+(/[a-z0-9]+)*$`)

// ValidKey reports whether key is safe to use as a relative path or object name.
func ValidKey(key string) bool { return validKey.MatchString(key) }
```

`server/internal/blob/fs.go`:
```go
package blob

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
)

// FS stores blobs as files under a root directory.
type FS struct{ root string }

func NewFS(root string) (*FS, error) {
	if err := os.MkdirAll(root, 0o750); err != nil {
		return nil, fmt.Errorf("create blob dir: %w", err)
	}
	return &FS{root: root}, nil
}

func (f *FS) path(key string) (string, error) {
	if !ValidKey(key) {
		return "", fmt.Errorf("invalid blob key %q", key)
	}
	return filepath.Join(f.root, filepath.FromSlash(key)), nil
}

func (f *FS) Put(_ context.Context, key string, r io.Reader) error {
	p, err := f.path(key)
	if err != nil {
		return err
	}
	dir := filepath.Dir(p)
	if err := os.MkdirAll(dir, 0o750); err != nil {
		return fmt.Errorf("create blob dir: %w", err)
	}
	tmp, err := os.CreateTemp(dir, ".tmp-*")
	if err != nil {
		return fmt.Errorf("create temp blob: %w", err)
	}
	cleanup := func() { tmp.Close(); os.Remove(tmp.Name()) }
	if _, err := io.Copy(tmp, r); err != nil {
		cleanup()
		return fmt.Errorf("write blob: %w", err)
	}
	if err := tmp.Sync(); err != nil {
		cleanup()
		return fmt.Errorf("sync blob: %w", err)
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmp.Name())
		return fmt.Errorf("close blob: %w", err)
	}
	if err := os.Rename(tmp.Name(), p); err != nil {
		os.Remove(tmp.Name())
		return fmt.Errorf("publish blob: %w", err)
	}
	return nil
}

func (f *FS) Get(_ context.Context, key string) (io.ReadCloser, error) {
	p, err := f.path(key)
	if err != nil {
		return nil, err
	}
	file, err := os.Open(p)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("open blob: %w", err)
	}
	return file, nil
}

func (f *FS) Delete(_ context.Context, key string) error {
	p, err := f.path(key)
	if err != nil {
		return err
	}
	if err := os.Remove(p); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return fmt.Errorf("delete blob: %w", err)
	}
	return nil
}

func (f *FS) Ping(_ context.Context) error {
	info, err := os.Stat(f.root)
	if err != nil {
		return fmt.Errorf("blob dir: %w", err)
	}
	if !info.IsDir() {
		return fmt.Errorf("blob dir %s is not a directory", f.root)
	}
	return nil
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd server && go test -race ./internal/blob/...`
Expected: `ok`

- [ ] **Step 5: Commit**

```bash
git add server/internal/blob
git commit -m "feat(blob): blob store interface, contract suite and filesystem backend

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Notification bus (interface, contract suite, in-memory)

**Files:**
- Create: `server/internal/bus/bus.go`, `server/internal/bus/memory.go`
- Create: `server/internal/bus/bustest/contract.go`
- Test: `server/internal/bus/memory_test.go`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```go
  type Notify struct { VaultID string; Seq int64 }
  type Bus interface {
      Publish(ctx context.Context, n Notify) error
      // Subscribe delivers notifications for vaultID. The channel holds at most one
      // pending value: if the reader lags, older notifications are replaced by the one
      // with the highest seq, so a slow reader never blocks publishers and never misses
      // the latest seq. cancel stops delivery and closes the channel.
      Subscribe(vaultID string) (<-chan Notify, func())
  }
  func NewMemory() *Memory
  // bustest
  func Run(t *testing.T, newBus func(t *testing.T) bus.Bus)
  ```
- The NATS implementation in sub-project 5 must pass the same `bustest.Run` suite.

- [ ] **Step 1: Write the contract suite and the failing test**

`server/internal/bus/bustest/contract.go`:
```go
// Package bustest is the behaviour every bus.Bus implementation must have.
package bustest

import (
	"context"
	"testing"
	"time"

	"github.com/jfms7s/obsidian-sync/server/internal/bus"
)

const wait = 2 * time.Second

func Run(t *testing.T, newBus func(t *testing.T) bus.Bus) {
	ctx := context.Background()

	t.Run("delivers to every subscriber of the vault", func(t *testing.T) {
		b := newBus(t)
		c1, cancel1 := b.Subscribe("v1")
		defer cancel1()
		c2, cancel2 := b.Subscribe("v1")
		defer cancel2()
		other, cancel3 := b.Subscribe("v2")
		defer cancel3()

		if err := b.Publish(ctx, bus.Notify{VaultID: "v1", Seq: 3}); err != nil {
			t.Fatal(err)
		}
		for _, c := range []<-chan bus.Notify{c1, c2} {
			if n := receive(t, c); n.Seq != 3 || n.VaultID != "v1" {
				t.Fatalf("got %+v", n)
			}
		}
		select {
		case n := <-other:
			t.Fatalf("other vault received %+v", n)
		case <-time.After(50 * time.Millisecond):
		}
	})

	t.Run("a lagging subscriber sees the highest seq", func(t *testing.T) {
		b := newBus(t)
		c, cancel := b.Subscribe("v1")
		defer cancel()
		for _, seq := range []int64{1, 5, 4} {
			if err := b.Publish(ctx, bus.Notify{VaultID: "v1", Seq: seq}); err != nil {
				t.Fatal(err)
			}
		}
		deadline := time.After(wait)
		for {
			select {
			case n := <-c:
				if n.Seq == 5 {
					return
				}
			case <-deadline:
				t.Fatal("never saw seq 5")
			}
		}
	})

	t.Run("cancel closes the channel and publish keeps working", func(t *testing.T) {
		b := newBus(t)
		c, cancel := b.Subscribe("v1")
		cancel()
		select {
		case _, ok := <-c:
			if ok {
				t.Fatal("channel delivered after cancel")
			}
		case <-time.After(wait):
			t.Fatal("channel not closed")
		}
		cancel() // idempotent
		if err := b.Publish(ctx, bus.Notify{VaultID: "v1", Seq: 1}); err != nil {
			t.Fatal(err)
		}
	})
}

func receive(t *testing.T, c <-chan bus.Notify) bus.Notify {
	t.Helper()
	select {
	case n := <-c:
		return n
	case <-time.After(wait):
		t.Fatal("no notification")
		return bus.Notify{}
	}
}
```

`server/internal/bus/memory_test.go`:
```go
package bus_test

import (
	"testing"

	"github.com/jfms7s/obsidian-sync/server/internal/bus"
	"github.com/jfms7s/obsidian-sync/server/internal/bus/bustest"
)

func TestMemory(t *testing.T) {
	bustest.Run(t, func(t *testing.T) bus.Bus { return bus.NewMemory() })
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd server && go test ./internal/bus/...`
Expected: FAIL because package `bus` does not exist.

- [ ] **Step 3: Implement**

`server/internal/bus/bus.go`:
```go
// Package bus carries "vault X reached seq N" notifications from the replica
// that committed to every replica holding WebSockets for that vault.
package bus

import "context"

type Notify struct {
	VaultID string
	Seq     int64
}

type Bus interface {
	Publish(ctx context.Context, n Notify) error
	// Subscribe delivers notifications for vaultID. The channel holds at most
	// one pending value, the highest seq seen, so a slow reader never blocks
	// publishers. cancel stops delivery and closes the channel; it is idempotent.
	Subscribe(vaultID string) (<-chan Notify, func())
}
```

`server/internal/bus/memory.go`:
```go
package bus

import (
	"context"
	"sync"
)

// Memory is the single-node Bus.
type Memory struct {
	mu   sync.Mutex
	subs map[string]map[*subscriber]struct{}
}

type subscriber struct{ ch chan Notify }

func NewMemory() *Memory { return &Memory{subs: map[string]map[*subscriber]struct{}{}} }

func (m *Memory) Publish(_ context.Context, n Notify) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	for s := range m.subs[n.VaultID] {
		// Publish is the only sender and holds mu, so after the drain below the
		// buffered slot is free and the send cannot block.
		select {
		case old := <-s.ch:
			if old.Seq > n.Seq {
				n = Notify{VaultID: n.VaultID, Seq: old.Seq}
			}
		default:
		}
		s.ch <- n
	}
	return nil
}

func (m *Memory) Subscribe(vaultID string) (<-chan Notify, func()) {
	s := &subscriber{ch: make(chan Notify, 1)}
	m.mu.Lock()
	if m.subs[vaultID] == nil {
		m.subs[vaultID] = map[*subscriber]struct{}{}
	}
	m.subs[vaultID][s] = struct{}{}
	m.mu.Unlock()

	var once sync.Once
	cancel := func() {
		once.Do(func() {
			m.mu.Lock()
			defer m.mu.Unlock()
			delete(m.subs[vaultID], s)
			if len(m.subs[vaultID]) == 0 {
				delete(m.subs, vaultID)
			}
			close(s.ch)
		})
	}
	return s.ch, cancel
}
```

Note that the loop variable `n` is reassigned inside the range loop. That's deliberate: each subscriber keeps the higher seq. Because seqs only grow, raising `n` for the rest of the loop is still correct.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd server && go test -race ./internal/bus/...`
Expected: `ok`

- [ ] **Step 5: Commit**

```bash
git add server/internal/bus
git commit -m "feat(bus): notification bus interface, contract suite and in-memory backend

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Typed errors and authentication

**Files:**
- Create: `server/internal/apperr/apperr.go`, `server/internal/apperr/apperr_test.go`
- Create: `server/internal/auth/password.go`, `server/internal/auth/token.go`, `server/internal/auth/limiter.go`, `server/internal/auth/service.go`
- Test: `server/internal/auth/password_test.go`, `server/internal/auth/limiter_test.go`, `server/internal/auth/service_test.go`

**Interfaces:**
- Consumes: `obsyncv1.ErrorCode` (Task 1), `ids` (Task 3), `store.User`, `store.Device`, `store.ErrNotFound`, `storetest` (Tasks 3–4).
- Produces:
  ```go
  // package apperr
  type Error struct { Code obsyncv1.ErrorCode; Msg string }
  func New(code obsyncv1.ErrorCode, format string, args ...any) *Error
  func CodeOf(err error) obsyncv1.ErrorCode // INTERNAL for errors that are not *Error
  const Conflict, QuotaExceeded, Unauthorized, DeviceRevoked, StaleEpoch, RateLimited,
        TooLarge, NotFound, Internal, Invalid, MissingChunk // = obsyncv1.ErrorCode_ERROR_CODE_*

  // package auth
  type Params struct { Memory, Iterations uint32; Parallelism uint8; SaltLen, KeyLen uint32 }
  var DefaultParams, FastParams Params // FastParams: tests only
  func HashPassword(password string, p Params) (string, error)
  func VerifyPassword(password, encoded string) (bool, error)
  func NewToken() (token string, hash []byte, err error)
  func HashToken(token string) []byte
  func NewLoginLimiter(burst int, refill time.Duration, now func() time.Time) *LoginLimiter
  func (l *LoginLimiter) Allow(key string) bool
  func (l *LoginLimiter) Fail(key string)
  func (l *LoginLimiter) Reset(key string)
  type Session struct { UserID, DeviceID string }
  type Store interface { UserByUsername; CreateDevice; DeviceByTokenHash; TouchDevice } // store signatures from Task 4
  type Options struct { Params Params; Now func() time.Time; Limiter *LoginLimiter }
  func NewService(st Store, opts Options) (*Service, error)
  type LoginRequest struct { Username, Password, DeviceName, Platform string }
  type LoginResult struct { Token string; Device store.Device }
  func (s *Service) Login(ctx context.Context, req LoginRequest) (LoginResult, error)
  func (s *Service) Authenticate(ctx context.Context, token string) (Session, error)
  var ErrInvalidCredentials, ErrRateLimited, ErrUnauthorized, ErrDeviceRevoked *apperr.Error
  ```

- [ ] **Step 1: Write the failing tests**

`server/internal/apperr/apperr_test.go`:
```go
package apperr_test

import (
	"errors"
	"fmt"
	"testing"

	"github.com/jfms7s/obsidian-sync/server/internal/apperr"
)

func TestCodeOf(t *testing.T) {
	wrapped := fmt.Errorf("context: %w", apperr.New(apperr.NotFound, "vault %s not found", "x"))
	if apperr.CodeOf(wrapped) != apperr.NotFound {
		t.Fatalf("code = %v", apperr.CodeOf(wrapped))
	}
	if apperr.CodeOf(errors.New("boom")) != apperr.Internal {
		t.Fatal("plain errors must map to INTERNAL")
	}
	if got := apperr.New(apperr.Invalid, "bad %d", 3).Error(); got != "bad 3" {
		t.Fatalf("message = %q", got)
	}
}
```

`server/internal/auth/password_test.go`:
```go
package auth_test

import (
	"strings"
	"testing"

	"github.com/jfms7s/obsidian-sync/server/internal/auth"
)

func TestHashAndVerifyPassword(t *testing.T) {
	h1, err := auth.HashPassword("correct horse", auth.FastParams)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(h1, "$argon2id$v=19$m=1024,t=1,p=1$") {
		t.Fatalf("encoding = %q", h1)
	}
	h2, _ := auth.HashPassword("correct horse", auth.FastParams)
	if h1 == h2 {
		t.Fatal("hashes must be salted")
	}
	if ok, err := auth.VerifyPassword("correct horse", h1); err != nil || !ok {
		t.Fatalf("verify ok=%v err=%v", ok, err)
	}
	if ok, _ := auth.VerifyPassword("wrong", h1); ok {
		t.Fatal("wrong password verified")
	}
	if _, err := auth.VerifyPassword("x", "$bcrypt$nope"); err == nil {
		t.Fatal("malformed hash must be an error")
	}
}

func TestToken(t *testing.T) {
	tok, hash, err := auth.NewToken()
	if err != nil {
		t.Fatal(err)
	}
	if len(tok) != 43 {
		t.Fatalf("token length = %d", len(tok))
	}
	if string(auth.HashToken(tok)) != string(hash) {
		t.Fatal("HashToken does not match the returned hash")
	}
	tok2, _, _ := auth.NewToken()
	if tok == tok2 {
		t.Fatal("tokens repeat")
	}
}
```

`server/internal/auth/limiter_test.go`:
```go
package auth_test

import (
	"testing"
	"time"

	"github.com/jfms7s/obsidian-sync/server/internal/auth"
	"github.com/jfms7s/obsidian-sync/server/internal/store/storetest"
)

func TestLoginLimiter(t *testing.T) {
	clk := storetest.NewClock()
	l := auth.NewLoginLimiter(3, time.Minute, clk.Now)
	for i := 0; i < 3; i++ {
		if !l.Allow("alice") {
			t.Fatalf("attempt %d refused", i)
		}
		l.Fail("alice")
	}
	if l.Allow("alice") {
		t.Fatal("4th attempt allowed")
	}
	if !l.Allow("bob") {
		t.Fatal("limits leak between keys")
	}
	clk.Advance(time.Minute)
	if !l.Allow("alice") {
		t.Fatal("no refill after a minute")
	}
	l.Fail("alice")
	if l.Allow("alice") {
		t.Fatal("refill granted more than one attempt")
	}
	l.Reset("alice")
	if !l.Allow("alice") {
		t.Fatal("reset did not clear")
	}
}
```

`server/internal/auth/service_test.go`:
```go
package auth_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jfms7s/obsidian-sync/server/internal/auth"
	"github.com/jfms7s/obsidian-sync/server/internal/ids"
	"github.com/jfms7s/obsidian-sync/server/internal/store"
	"github.com/jfms7s/obsidian-sync/server/internal/store/storetest"
)

var ctx = context.Background()

func newService(t *testing.T) (*auth.Service, *store.Store, *storetest.Clock) {
	t.Helper()
	st, clk := storetest.New(t)
	hash, err := auth.HashPassword("correct horse", auth.FastParams)
	if err != nil {
		t.Fatal(err)
	}
	if err := st.CreateUser(ctx, store.User{ID: ids.New(), Username: "alice", PasswordHash: hash, QuotaBytes: 1}); err != nil {
		t.Fatal(err)
	}
	svc, err := auth.NewService(st, auth.Options{Params: auth.FastParams, Now: clk.Now})
	if err != nil {
		t.Fatal(err)
	}
	return svc, st, clk
}

func TestLoginThenAuthenticate(t *testing.T) {
	svc, _, _ := newService(t)
	res, err := svc.Login(ctx, auth.LoginRequest{Username: "Alice", Password: "correct horse", DeviceName: "  laptop ", Platform: "linux"})
	if err != nil {
		t.Fatal(err)
	}
	if res.Token == "" || res.Device.Name != "laptop" || res.Device.Platform != "linux" {
		t.Fatalf("res = %+v", res)
	}
	sess, err := svc.Authenticate(ctx, res.Token)
	if err != nil || sess.DeviceID != res.Device.ID || sess.UserID != res.Device.UserID {
		t.Fatalf("sess = %+v, err %v", sess, err)
	}
}

func TestLoginFailures(t *testing.T) {
	svc, _, _ := newService(t)
	if _, err := svc.Login(ctx, auth.LoginRequest{Username: "alice", Password: "nope"}); !errors.Is(err, auth.ErrInvalidCredentials) {
		t.Fatalf("wrong password err = %v", err)
	}
	if _, err := svc.Login(ctx, auth.LoginRequest{Username: "mallory", Password: "x"}); !errors.Is(err, auth.ErrInvalidCredentials) {
		t.Fatalf("unknown user err = %v", err)
	}
}

func TestLoginIsRateLimitedPerUsername(t *testing.T) {
	svc, _, clk := newService(t)
	for i := 0; i < 5; i++ {
		_, _ = svc.Login(ctx, auth.LoginRequest{Username: "alice", Password: "guess"})
	}
	if _, err := svc.Login(ctx, auth.LoginRequest{Username: "ALICE", Password: "correct horse"}); !errors.Is(err, auth.ErrRateLimited) {
		t.Fatalf("err = %v, want rate limited even with the right password", err)
	}
	clk.Advance(time.Minute)
	if _, err := svc.Login(ctx, auth.LoginRequest{Username: "alice", Password: "correct horse"}); err != nil {
		t.Fatalf("after refill: %v", err)
	}
}

func TestAuthenticateRejections(t *testing.T) {
	svc, st, _ := newService(t)
	if _, err := svc.Authenticate(ctx, ""); !errors.Is(err, auth.ErrUnauthorized) {
		t.Fatalf("empty token err = %v", err)
	}
	if _, err := svc.Authenticate(ctx, "not-a-token"); !errors.Is(err, auth.ErrUnauthorized) {
		t.Fatalf("unknown token err = %v", err)
	}
	res, _ := svc.Login(ctx, auth.LoginRequest{Username: "alice", Password: "correct horse"})
	if err := st.RevokeDevice(ctx, res.Device.UserID, res.Device.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Authenticate(ctx, res.Token); !errors.Is(err, auth.ErrDeviceRevoked) {
		t.Fatalf("revoked err = %v", err)
	}
}

func TestAuthenticateRefreshesLastSeenAtMostOncePerMinute(t *testing.T) {
	svc, st, clk := newService(t)
	res, _ := svc.Login(ctx, auth.LoginRequest{Username: "alice", Password: "correct horse"})
	start := clk.Now().UnixMilli()

	clk.Advance(30 * time.Second)
	_, _ = svc.Authenticate(ctx, res.Token)
	if d, _ := st.DeviceByTokenHash(ctx, auth.HashToken(res.Token)); d.LastSeenAtMs != start {
		t.Fatalf("touched too early: %d", d.LastSeenAtMs)
	}
	clk.Advance(61 * time.Second)
	_, _ = svc.Authenticate(ctx, res.Token)
	if d, _ := st.DeviceByTokenHash(ctx, auth.HashToken(res.Token)); d.LastSeenAtMs != clk.Now().UnixMilli() {
		t.Fatalf("not touched: %d", d.LastSeenAtMs)
	}
}
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd server && go test ./internal/apperr/ ./internal/auth/`
Expected: FAIL because the packages don't exist.

- [ ] **Step 3: Implement `apperr`**

`server/internal/apperr/apperr.go`:
```go
// Package apperr carries a protocol ErrorCode with an error, so every layer
// can say what went wrong in terms a client acts on.
package apperr

import (
	"errors"
	"fmt"

	obsyncv1 "github.com/jfms7s/obsidian-sync/server/internal/gen/obsync/v1"
)

const (
	Conflict      = obsyncv1.ErrorCode_ERROR_CODE_CONFLICT
	QuotaExceeded = obsyncv1.ErrorCode_ERROR_CODE_QUOTA_EXCEEDED
	Unauthorized  = obsyncv1.ErrorCode_ERROR_CODE_UNAUTHORIZED
	DeviceRevoked = obsyncv1.ErrorCode_ERROR_CODE_DEVICE_REVOKED
	StaleEpoch    = obsyncv1.ErrorCode_ERROR_CODE_STALE_EPOCH
	RateLimited   = obsyncv1.ErrorCode_ERROR_CODE_RATE_LIMITED
	TooLarge      = obsyncv1.ErrorCode_ERROR_CODE_TOO_LARGE
	NotFound      = obsyncv1.ErrorCode_ERROR_CODE_NOT_FOUND
	Internal      = obsyncv1.ErrorCode_ERROR_CODE_INTERNAL
	Invalid       = obsyncv1.ErrorCode_ERROR_CODE_INVALID
	MissingChunk  = obsyncv1.ErrorCode_ERROR_CODE_MISSING_CHUNK
)

// Error is an error whose message is safe to show to the client.
type Error struct {
	Code obsyncv1.ErrorCode
	Msg  string
}

func (e *Error) Error() string { return e.Msg }

func New(code obsyncv1.ErrorCode, format string, args ...any) *Error {
	return &Error{Code: code, Msg: fmt.Sprintf(format, args...)}
}

// CodeOf returns the code of the first *Error in err's chain, or Internal.
func CodeOf(err error) obsyncv1.ErrorCode {
	var e *Error
	if errors.As(err, &e) {
		return e.Code
	}
	return Internal
}
```

- [ ] **Step 4: Implement `auth`**

Run: `cd server && go get golang.org/x/crypto@v0.31.0`

`server/internal/auth/password.go`:
```go
package auth

import (
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"

	"golang.org/x/crypto/argon2"

	"github.com/jfms7s/obsidian-sync/server/internal/ids"
)

// Params are argon2id costs. Memory is in KiB.
type Params struct {
	Memory      uint32
	Iterations  uint32
	Parallelism uint8
	SaltLen     uint32
	KeyLen      uint32
}

// DefaultParams follow OWASP's argon2id guidance with headroom (64 MiB, t=2).
var DefaultParams = Params{Memory: 64 * 1024, Iterations: 2, Parallelism: 2, SaltLen: 16, KeyLen: 32}

// FastParams are for tests only; never use them for real accounts.
var FastParams = Params{Memory: 1024, Iterations: 1, Parallelism: 1, SaltLen: 16, KeyLen: 32}

var errMalformedHash = errors.New("malformed password hash")

// HashPassword returns a PHC-format argon2id hash.
func HashPassword(password string, p Params) (string, error) {
	salt := ids.Bytes(int(p.SaltLen))
	key := argon2.IDKey([]byte(password), salt, p.Iterations, p.Memory, p.Parallelism, p.KeyLen)
	return fmt.Sprintf("$argon2id$v=%d$m=%d,t=%d,p=%d$%s$%s", argon2.Version, p.Memory, p.Iterations, p.Parallelism,
		base64.RawStdEncoding.EncodeToString(salt), base64.RawStdEncoding.EncodeToString(key)), nil
}

// VerifyPassword checks password against a hash from HashPassword, using the
// costs recorded in the hash.
func VerifyPassword(password, encoded string) (bool, error) {
	parts := strings.Split(encoded, "$")
	if len(parts) != 6 || parts[1] != "argon2id" {
		return false, errMalformedHash
	}
	var version int
	if _, err := fmt.Sscanf(parts[2], "v=%d", &version); err != nil || version != argon2.Version {
		return false, errMalformedHash
	}
	var p Params
	if _, err := fmt.Sscanf(parts[3], "m=%d,t=%d,p=%d", &p.Memory, &p.Iterations, &p.Parallelism); err != nil {
		return false, errMalformedHash
	}
	salt, err := base64.RawStdEncoding.DecodeString(parts[4])
	if err != nil {
		return false, errMalformedHash
	}
	want, err := base64.RawStdEncoding.DecodeString(parts[5])
	if err != nil || len(want) == 0 {
		return false, errMalformedHash
	}
	got := argon2.IDKey([]byte(password), salt, p.Iterations, p.Memory, p.Parallelism, uint32(len(want)))
	return subtle.ConstantTimeCompare(got, want) == 1, nil
}
```

`server/internal/auth/token.go`:
```go
package auth

import (
	"crypto/sha256"
	"encoding/base64"

	"github.com/jfms7s/obsidian-sync/server/internal/ids"
)

// NewToken returns a device bearer token (256 random bits, base64url) and the
// SHA-256 hash that is all the server stores.
func NewToken() (string, []byte, error) {
	token := base64.RawURLEncoding.EncodeToString(ids.Bytes(32))
	return token, HashToken(token), nil
}

func HashToken(token string) []byte {
	h := sha256.Sum256([]byte(token))
	return h[:]
}
```

`server/internal/auth/limiter.go`:
```go
package auth

import (
	"math"
	"sync"
	"time"
)

// LoginLimiter is a token bucket per key (a lowercased username): Burst
// failed attempts, refilled at one attempt per Refill. Successes reset it.
type LoginLimiter struct {
	mu      sync.Mutex
	burst   float64
	refill  time.Duration
	now     func() time.Time
	buckets map[string]*bucket
}

type bucket struct {
	tokens float64
	last   time.Time
}

const maxTrackedKeys = 10000

func NewLoginLimiter(burst int, refill time.Duration, now func() time.Time) *LoginLimiter {
	return &LoginLimiter{burst: float64(burst), refill: refill, now: now, buckets: map[string]*bucket{}}
}

// refreshed returns key's bucket with tokens refilled up to now, or nil if
// the key has no failures on record. Caller holds mu.
func (l *LoginLimiter) refreshed(key string) *bucket {
	b, ok := l.buckets[key]
	if !ok {
		return nil
	}
	now := l.now()
	b.tokens = math.Min(l.burst, b.tokens+float64(now.Sub(b.last))/float64(l.refill))
	b.last = now
	return b
}

func (l *LoginLimiter) Allow(key string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	b := l.refreshed(key)
	return b == nil || b.tokens >= 1
}

func (l *LoginLimiter) Fail(key string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	b := l.refreshed(key)
	if b == nil {
		if len(l.buckets) >= maxTrackedKeys {
			l.evictFull()
		}
		b = &bucket{tokens: l.burst, last: l.now()}
		l.buckets[key] = b
	}
	b.tokens = math.Max(0, b.tokens-1)
}

func (l *LoginLimiter) Reset(key string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	delete(l.buckets, key)
}

// evictFull forgets keys whose bucket has refilled completely. Caller holds mu.
func (l *LoginLimiter) evictFull() {
	now := l.now()
	for k, b := range l.buckets {
		if b.tokens+float64(now.Sub(b.last))/float64(l.refill) >= l.burst {
			delete(l.buckets, k)
		}
	}
}
```

`server/internal/auth/service.go`:
```go
// Package auth logs devices in with a username and password and
// authenticates their bearer tokens.
package auth

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jfms7s/obsidian-sync/server/internal/apperr"
	"github.com/jfms7s/obsidian-sync/server/internal/ids"
	"github.com/jfms7s/obsidian-sync/server/internal/store"
)

var (
	ErrInvalidCredentials = apperr.New(apperr.Unauthorized, "invalid username or password")
	ErrRateLimited        = apperr.New(apperr.RateLimited, "too many failed logins; try again later")
	ErrUnauthorized       = apperr.New(apperr.Unauthorized, "missing or unknown token")
	ErrDeviceRevoked      = apperr.New(apperr.DeviceRevoked, "this device has been revoked")
)

// touchInterval bounds how often a device's last-seen time is written.
const touchInterval = time.Minute

type Store interface {
	UserByUsername(ctx context.Context, username string) (store.User, error)
	CreateDevice(ctx context.Context, d store.Device, tokenHash []byte) error
	DeviceByTokenHash(ctx context.Context, tokenHash []byte) (store.Device, error)
	TouchDevice(ctx context.Context, deviceID string) error
}

type Session struct {
	UserID   string
	DeviceID string
}

type Options struct {
	Params  Params // cost of the timing-equalising dummy hash; match real hashes
	Now     func() time.Time
	Limiter *LoginLimiter
}

type Service struct {
	st        Store
	now       func() time.Time
	limiter   *LoginLimiter
	dummyHash string
}

func NewService(st Store, opts Options) (*Service, error) {
	if opts.Now == nil {
		opts.Now = time.Now
	}
	if opts.Limiter == nil {
		opts.Limiter = NewLoginLimiter(5, time.Minute, opts.Now)
	}
	dummy, err := HashPassword("obsync-timing-dummy", opts.Params)
	if err != nil {
		return nil, fmt.Errorf("dummy hash: %w", err)
	}
	return &Service{st: st, now: opts.Now, limiter: opts.Limiter, dummyHash: dummy}, nil
}

type LoginRequest struct {
	Username   string
	Password   string
	DeviceName string
	Platform   string
}

type LoginResult struct {
	Token  string
	Device store.Device
}

func (s *Service) Login(ctx context.Context, req LoginRequest) (LoginResult, error) {
	key := strings.ToLower(strings.TrimSpace(req.Username))
	if !s.limiter.Allow(key) {
		return LoginResult{}, ErrRateLimited
	}
	user, err := s.st.UserByUsername(ctx, strings.TrimSpace(req.Username))
	if errors.Is(err, store.ErrNotFound) {
		// Spend the same time as a real check so unknown usernames don't show.
		_, _ = VerifyPassword(req.Password, s.dummyHash)
		s.limiter.Fail(key)
		return LoginResult{}, ErrInvalidCredentials
	}
	if err != nil {
		return LoginResult{}, fmt.Errorf("look up user: %w", err)
	}
	ok, err := VerifyPassword(req.Password, user.PasswordHash)
	if err != nil {
		return LoginResult{}, fmt.Errorf("verify password: %w", err)
	}
	if !ok {
		s.limiter.Fail(key)
		return LoginResult{}, ErrInvalidCredentials
	}
	s.limiter.Reset(key)

	token, hash, err := NewToken()
	if err != nil {
		return LoginResult{}, err
	}
	dev := store.Device{
		ID:       ids.New(),
		UserID:   user.ID,
		Name:     clean(req.DeviceName, "unnamed device", 100),
		Platform: clean(req.Platform, "unknown", 32),
	}
	if err := s.st.CreateDevice(ctx, dev, hash); err != nil {
		return LoginResult{}, err
	}
	stored, err := s.st.DeviceByTokenHash(ctx, hash)
	if err != nil {
		return LoginResult{}, fmt.Errorf("read new device: %w", err)
	}
	return LoginResult{Token: token, Device: stored}, nil
}

func (s *Service) Authenticate(ctx context.Context, token string) (Session, error) {
	if token == "" {
		return Session{}, ErrUnauthorized
	}
	dev, err := s.st.DeviceByTokenHash(ctx, HashToken(token))
	if errors.Is(err, store.ErrNotFound) {
		return Session{}, ErrUnauthorized
	}
	if err != nil {
		return Session{}, fmt.Errorf("look up device: %w", err)
	}
	if dev.Revoked() {
		return Session{}, ErrDeviceRevoked
	}
	if s.now().UnixMilli()-dev.LastSeenAtMs > touchInterval.Milliseconds() {
		if err := s.st.TouchDevice(ctx, dev.ID); err != nil {
			return Session{}, err
		}
	}
	return Session{UserID: dev.UserID, DeviceID: dev.ID}, nil
}

// clean trims s, substitutes def when empty and truncates to max runes.
func clean(s, def string, max int) string {
	s = strings.TrimSpace(s)
	if s == "" {
		return def
	}
	if utf8.RuneCountInString(s) > max {
		s = string([]rune(s)[:max])
	}
	return s
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd server && go mod tidy && go test -race ./internal/apperr/ ./internal/auth/`
Expected: `ok` for both.

- [ ] **Step 6: Commit**

```bash
git add server/go.mod server/go.sum server/internal/apperr server/internal/auth
git commit -m "feat(auth): password login, device tokens and login rate limiting

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Sync service

**Files:**
- Create: `server/internal/syncsvc/service.go`
- Test: `server/internal/syncsvc/service_test.go`

**Interfaces:**
- Consumes: `store` types and methods (Tasks 4–7), `blob.Store` (Task 8), `bus.Bus` (Task 9), `apperr`, `ids` (Tasks 3, 10).
- Produces:
  ```go
  const ChunkSize = 4 << 20; MaxChunkCipherBytes = ChunkSize + 64; MaxCommitsPerRequest = 500
  const MaxEncMetaBytes = 64 << 10; MaxChunkExistsBatch = 1000
  const DefaultPageSize = 500; MaxPageSize = 1000; DefaultHeadsPageSize = 1000; MaxHeadsPageSize = 5000
  type Store interface { VaultForMember; UserByID; UsageBytes; TouchChunks; InsertChunk; ChunkBlobKey; Commit; Changes; Heads; History; Trash }
  type Limits struct { MaxFileSizeBytes int64 }
  func New(st Store, blobs blob.Store, b bus.Bus, limits Limits, log *slog.Logger) *Service
  func (s *Service) ChunksExist(ctx context.Context, userID, vaultID string, chunkIDs [][]byte) ([]bool, error)
  func (s *Service) PutChunk(ctx context.Context, userID, vaultID string, chunkID []byte, body io.Reader, size int64) error
  func (s *Service) OpenChunk(ctx context.Context, userID, vaultID string, chunkID []byte) (io.ReadCloser, error)
  type CommitResult struct { FileID []byte; Seq int64; Err *apperr.Error; HeadVersionID []byte }
  func (s *Service) Commit(ctx context.Context, userID, deviceID, vaultID string, commits []store.Version) ([]CommitResult, int64, error)
  type ChangesPage struct { Versions []store.Version; VaultSeq int64; More bool }
  func (s *Service) Changes(ctx context.Context, userID, vaultID string, since int64, limit int) (ChangesPage, error)
  type HeadsPage struct { Heads []store.Head; More bool }
  func (s *Service) Heads(ctx context.Context, userID, vaultID string, after []byte, limit int) (HeadsPage, error)
  func (s *Service) History(ctx context.Context, userID, vaultID string, fileID []byte) ([]store.Version, error)
  func (s *Service) Trash(ctx context.Context, userID, vaultID string) ([]store.Version, error)
  ```
- Every method first checks that `userID` is a member of `vaultID`. Non-members get `NotFound` (not `Unauthorized`), so a vault's existence never leaks. Methods return `*apperr.Error` for anything the client caused, and plain errors for infrastructure failures.

- [ ] **Step 1: Write the failing tests**

`server/internal/syncsvc/service_test.go`:
```go
package syncsvc_test

import (
	"bytes"
	"context"
	"io"
	"io/fs"
	"log/slog"
	"path/filepath"
	"testing"
	"time"

	"github.com/jfms7s/obsidian-sync/server/internal/apperr"
	"github.com/jfms7s/obsidian-sync/server/internal/blob"
	"github.com/jfms7s/obsidian-sync/server/internal/bus"
	"github.com/jfms7s/obsidian-sync/server/internal/ids"
	"github.com/jfms7s/obsidian-sync/server/internal/store"
	"github.com/jfms7s/obsidian-sync/server/internal/store/storetest"
	"github.com/jfms7s/obsidian-sync/server/internal/syncsvc"
)

var ctx = context.Background()

type fixture struct {
	svc     *syncsvc.Service
	st      *store.Store
	bus     *bus.Memory
	blobDir string
	user    store.User
	vault   store.Vault
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	st, _ := storetest.New(t)
	dir := t.TempDir()
	blobs, err := blob.NewFS(dir)
	if err != nil {
		t.Fatal(err)
	}
	b := bus.NewMemory()
	user := storetest.SeedUser(t, st, "alice")
	vault := storetest.SeedVault(t, st, user.ID)
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	svc := syncsvc.New(st, blobs, b, syncsvc.Limits{MaxFileSizeBytes: 64 << 20}, log)
	return &fixture{svc: svc, st: st, bus: b, blobDir: dir, user: user, vault: vault}
}

func (f *fixture) put(t *testing.T, id []byte, data string) {
	t.Helper()
	if err := f.svc.PutChunk(ctx, f.user.ID, f.vault.ID, id, bytes.NewReader([]byte(data)), int64(len(data))); err != nil {
		t.Fatalf("put chunk: %v", err)
	}
}

func (f *fixture) blobCount(t *testing.T) int {
	t.Helper()
	n := 0
	_ = filepath.WalkDir(f.blobDir, func(_ string, d fs.DirEntry, err error) error {
		if err == nil && d.Type().IsRegular() {
			n++
		}
		return nil
	})
	return n
}

func version(file byte, base []byte, chunks ...[]byte) store.Version {
	return store.Version{FileID: storetest.FileID(file), VersionID: ids.Bytes(16), BaseVersionID: base, Epoch: 1,
		EncMeta: []byte("meta"), ChunkIDs: chunks, Size: int64(len(chunks))}
}

func TestPutAndOpenChunk(t *testing.T) {
	f := newFixture(t)
	f.put(t, storetest.ChunkID(1), "hello")
	exists, err := f.svc.ChunksExist(ctx, f.user.ID, f.vault.ID, [][]byte{storetest.ChunkID(1), storetest.ChunkID(2)})
	if err != nil || !exists[0] || exists[1] {
		t.Fatalf("exists = %v, err %v", exists, err)
	}
	rc, err := f.svc.OpenChunk(ctx, f.user.ID, f.vault.ID, storetest.ChunkID(1))
	if err != nil {
		t.Fatal(err)
	}
	data, _ := io.ReadAll(rc)
	rc.Close()
	if string(data) != "hello" {
		t.Fatalf("data = %q", data)
	}
	if _, err := f.svc.OpenChunk(ctx, f.user.ID, f.vault.ID, storetest.ChunkID(2)); apperr.CodeOf(err) != apperr.NotFound {
		t.Fatalf("missing chunk err = %v", err)
	}
}

func TestPutChunkTwiceStoresOnce(t *testing.T) {
	f := newFixture(t)
	f.put(t, storetest.ChunkID(1), "hello")
	f.put(t, storetest.ChunkID(1), "hello")
	if used, _ := f.st.UsageBytes(ctx, f.user.ID); used != 5 {
		t.Fatalf("usage = %d", used)
	}
	if n := f.blobCount(t); n != 1 {
		t.Fatalf("%d blobs on disk, want 1", n)
	}
}

func TestPutChunkRejectsSizeMismatch(t *testing.T) {
	f := newFixture(t)
	for _, size := range []int64{10, 2} { // body shorter, then longer, than declared
		err := f.svc.PutChunk(ctx, f.user.ID, f.vault.ID, storetest.ChunkID(1), bytes.NewReader([]byte("hello")), size)
		if apperr.CodeOf(err) != apperr.Invalid {
			t.Fatalf("size %d: err = %v", size, err)
		}
	}
	if exists, _ := f.svc.ChunksExist(ctx, f.user.ID, f.vault.ID, [][]byte{storetest.ChunkID(1)}); exists[0] {
		t.Fatal("truncated chunk was recorded")
	}
	if used, _ := f.st.UsageBytes(ctx, f.user.ID); used != 0 {
		t.Fatalf("usage = %d", used)
	}
	if n := f.blobCount(t); n != 0 {
		t.Fatalf("%d blobs left on disk", n)
	}
}

func TestPutChunkLimits(t *testing.T) {
	f := newFixture(t)
	err := f.svc.PutChunk(ctx, f.user.ID, f.vault.ID, storetest.ChunkID(1), bytes.NewReader(nil), syncsvc.MaxChunkCipherBytes+1)
	if apperr.CodeOf(err) != apperr.TooLarge {
		t.Fatalf("oversized err = %v", err)
	}
	err = f.svc.PutChunk(ctx, f.user.ID, f.vault.ID, []byte("short"), bytes.NewReader([]byte("x")), 1)
	if apperr.CodeOf(err) != apperr.Invalid {
		t.Fatalf("bad id err = %v", err)
	}
}

func TestPutChunkEnforcesQuota(t *testing.T) {
	f := newFixture(t)
	small := store.User{ID: ids.New(), Username: "small", PasswordHash: "x", QuotaBytes: 8}
	if err := f.st.CreateUser(ctx, small); err != nil {
		t.Fatal(err)
	}
	v := storetest.SeedVault(t, f.st, small.ID)
	if err := f.svc.PutChunk(ctx, small.ID, v.ID, storetest.ChunkID(1), bytes.NewReader([]byte("12345")), 5); err != nil {
		t.Fatal(err)
	}
	err := f.svc.PutChunk(ctx, small.ID, v.ID, storetest.ChunkID(2), bytes.NewReader([]byte("12345")), 5)
	if apperr.CodeOf(err) != apperr.QuotaExceeded {
		t.Fatalf("err = %v", err)
	}
}

func TestNonMembersGetNotFound(t *testing.T) {
	f := newFixture(t)
	bob := storetest.SeedUser(t, f.st, "bob")
	if _, err := f.svc.ChunksExist(ctx, bob.ID, f.vault.ID, [][]byte{storetest.ChunkID(1)}); apperr.CodeOf(err) != apperr.NotFound {
		t.Fatalf("exists err = %v", err)
	}
	if _, _, err := f.svc.Commit(ctx, bob.ID, "dev", f.vault.ID, []store.Version{version(1, nil)}); apperr.CodeOf(err) != apperr.NotFound {
		t.Fatalf("commit err = %v", err)
	}
	if _, err := f.svc.Changes(ctx, f.user.ID, "not-a-vault-id", 0, 0); apperr.CodeOf(err) != apperr.NotFound {
		t.Fatalf("malformed vault id err = %v", err)
	}
}

func TestCommitPublishesNotify(t *testing.T) {
	f := newFixture(t)
	ch, cancel := f.bus.Subscribe(f.vault.ID)
	defer cancel()
	f.put(t, storetest.ChunkID(1), "hello")
	results, vaultSeq, err := f.svc.Commit(ctx, f.user.ID, "dev-1", f.vault.ID, []store.Version{version(1, nil, storetest.ChunkID(1))})
	if err != nil || len(results) != 1 || results[0].Err != nil || results[0].Seq != 1 || vaultSeq != 1 {
		t.Fatalf("results = %+v, vaultSeq %d, err %v", results, vaultSeq, err)
	}
	select {
	case n := <-ch:
		if n.Seq != 1 {
			t.Fatalf("notify seq = %d", n.Seq)
		}
	case <-time.After(time.Second):
		t.Fatal("no notification")
	}
	changes, _ := f.svc.Changes(ctx, f.user.ID, f.vault.ID, 0, 0)
	if changes.Versions[0].DeviceID != "dev-1" {
		t.Fatalf("device id = %q", changes.Versions[0].DeviceID)
	}
}

func TestCommitReportsEachCommitsOutcome(t *testing.T) {
	f := newFixture(t)
	f.put(t, storetest.ChunkID(1), "a")
	if _, _, err := f.svc.Commit(ctx, f.user.ID, "d", f.vault.ID, []store.Version{version(1, nil, storetest.ChunkID(1))}); err != nil {
		t.Fatal(err)
	}

	badID := version(2, nil)
	badID.FileID = []byte("short")
	stale := version(3, nil)
	stale.Epoch = 2
	tooBig := version(4, nil)
	tooBig.Size = 65 << 20

	results, _, err := f.svc.Commit(ctx, f.user.ID, "d", f.vault.ID, []store.Version{
		version(5, nil),                        // ok
		badID,                                  // invalid
		version(6, nil, storetest.ChunkID(9)),  // missing chunk
		stale,                                  // stale epoch
		version(1, nil),                        // conflict: file 1 exists
		tooBig,                                 // too large
	})
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"", "ERROR_CODE_INVALID", "ERROR_CODE_MISSING_CHUNK", "ERROR_CODE_STALE_EPOCH", "ERROR_CODE_CONFLICT", "ERROR_CODE_TOO_LARGE"}
	for i, r := range results {
		got := ""
		if r.Err != nil {
			got = r.Err.Code.String()
		}
		if got != want[i] {
			t.Errorf("result %d = %q, want %q", i, got, want[i])
		}
	}
	if len(results[4].HeadVersionID) != 16 {
		t.Errorf("conflict carries no head: %x", results[4].HeadVersionID)
	}
}

func TestCommitBatchSize(t *testing.T) {
	f := newFixture(t)
	if _, _, err := f.svc.Commit(ctx, f.user.ID, "d", f.vault.ID, nil); apperr.CodeOf(err) != apperr.Invalid {
		t.Fatalf("empty batch err = %v", err)
	}
	batch := make([]store.Version, syncsvc.MaxCommitsPerRequest+1)
	if _, _, err := f.svc.Commit(ctx, f.user.ID, "d", f.vault.ID, batch); apperr.CodeOf(err) != apperr.Invalid {
		t.Fatalf("oversized batch err = %v", err)
	}
}

func TestChangesPaging(t *testing.T) {
	f := newFixture(t)
	for b := byte(1); b <= 3; b++ {
		if _, _, err := f.svc.Commit(ctx, f.user.ID, "d", f.vault.ID, []store.Version{version(b, nil)}); err != nil {
			t.Fatal(err)
		}
	}
	page, err := f.svc.Changes(ctx, f.user.ID, f.vault.ID, 0, 2)
	if err != nil || len(page.Versions) != 2 || !page.More || page.VaultSeq != 3 {
		t.Fatalf("page 1 = %+v, err %v", page, err)
	}
	page, _ = f.svc.Changes(ctx, f.user.ID, f.vault.ID, 2, 2)
	if len(page.Versions) != 1 || page.More {
		t.Fatalf("page 2 = %+v", page)
	}
	page, _ = f.svc.Changes(ctx, f.user.ID, f.vault.ID, 3, 2)
	if len(page.Versions) != 0 || page.More || page.VaultSeq != 3 {
		t.Fatalf("caught-up page = %+v", page)
	}
	if _, err := f.svc.Changes(ctx, f.user.ID, f.vault.ID, -1, 0); apperr.CodeOf(err) != apperr.Invalid {
		t.Fatalf("negative since err = %v", err)
	}
}
```

The exact head value a conflict returns is already pinned in Task 7. This test only checks that a conflict carries a 16-byte head at all.

- [ ] **Step 2: Run them to verify they fail**

Run: `cd server && go test ./internal/syncsvc/`
Expected: FAIL because package `syncsvc` does not exist.

- [ ] **Step 3: Implement**

`server/internal/syncsvc/service.go`:
```go
// Package syncsvc implements the sync operations on top of the store, the
// blob store and the bus: chunk upload/download, commits, and the change log.
package syncsvc

import (
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log/slog"

	"github.com/jfms7s/obsidian-sync/server/internal/apperr"
	"github.com/jfms7s/obsidian-sync/server/internal/blob"
	"github.com/jfms7s/obsidian-sync/server/internal/bus"
	"github.com/jfms7s/obsidian-sync/server/internal/ids"
	"github.com/jfms7s/obsidian-sync/server/internal/store"
)

const (
	ChunkSize            = 4 << 20
	MaxChunkCipherBytes  = ChunkSize + 64 // AES-GCM nonce + tag fit with room to spare
	MaxCommitsPerRequest = 500
	MaxEncMetaBytes      = 64 << 10
	MaxChunkExistsBatch  = 1000
	DefaultPageSize      = 500
	MaxPageSize          = 1000
	DefaultHeadsPageSize = 1000
	MaxHeadsPageSize     = 5000

	fileIDLen    = 32
	versionIDLen = 16
	chunkIDLen   = 32
)

type Store interface {
	VaultForMember(ctx context.Context, vaultID, userID string) (store.Vault, error)
	UserByID(ctx context.Context, id string) (store.User, error)
	UsageBytes(ctx context.Context, ownerID string) (int64, error)
	TouchChunks(ctx context.Context, vaultID string, chunkIDs [][]byte) ([]bool, error)
	InsertChunk(ctx context.Context, c store.Chunk) (bool, error)
	ChunkBlobKey(ctx context.Context, vaultID string, chunkID []byte) (string, error)
	Commit(ctx context.Context, v store.Version) (store.CommitOutcome, error)
	Changes(ctx context.Context, vaultID string, since int64, limit int) ([]store.Version, error)
	Heads(ctx context.Context, vaultID string, after []byte, limit int) ([]store.Head, error)
	History(ctx context.Context, vaultID string, fileID []byte) ([]store.Version, error)
	Trash(ctx context.Context, vaultID string) ([]store.Version, error)
}

type Limits struct {
	MaxFileSizeBytes int64
}

type Service struct {
	st     Store
	blobs  blob.Store
	bus    bus.Bus
	limits Limits
	log    *slog.Logger
}

func New(st Store, blobs blob.Store, b bus.Bus, limits Limits, log *slog.Logger) *Service {
	return &Service{st: st, blobs: blobs, bus: b, limits: limits, log: log}
}

var errVaultNotFound = apperr.New(apperr.NotFound, "vault not found")

// vault loads vaultID if userID is a member. Anything else is NotFound so a
// vault's existence never leaks to outsiders.
func (s *Service) vault(ctx context.Context, userID, vaultID string) (store.Vault, error) {
	if !ids.Valid(vaultID) {
		return store.Vault{}, errVaultNotFound
	}
	v, err := s.st.VaultForMember(ctx, vaultID, userID)
	if errors.Is(err, store.ErrNotFound) {
		return store.Vault{}, errVaultNotFound
	}
	if err != nil {
		return store.Vault{}, fmt.Errorf("load vault: %w", err)
	}
	return v, nil
}

func (s *Service) ChunksExist(ctx context.Context, userID, vaultID string, chunkIDs [][]byte) ([]bool, error) {
	if len(chunkIDs) == 0 || len(chunkIDs) > MaxChunkExistsBatch {
		return nil, apperr.New(apperr.Invalid, "send between 1 and %d chunk ids", MaxChunkExistsBatch)
	}
	for _, id := range chunkIDs {
		if len(id) != chunkIDLen {
			return nil, apperr.New(apperr.Invalid, "chunk ids must be %d bytes", chunkIDLen)
		}
	}
	if _, err := s.vault(ctx, userID, vaultID); err != nil {
		return nil, err
	}
	return s.st.TouchChunks(ctx, vaultID, chunkIDs)
}

// PutChunk stores one encrypted chunk of exactly size bytes read from body.
// Uploading a chunk the vault already has is a no-op.
func (s *Service) PutChunk(ctx context.Context, userID, vaultID string, chunkID []byte, body io.Reader, size int64) error {
	if len(chunkID) != chunkIDLen {
		return apperr.New(apperr.Invalid, "chunk id must be %d bytes", chunkIDLen)
	}
	if size <= 0 {
		return apperr.New(apperr.Invalid, "chunk body must not be empty")
	}
	if size > MaxChunkCipherBytes {
		return apperr.New(apperr.TooLarge, "chunk exceeds %d bytes", MaxChunkCipherBytes)
	}
	v, err := s.vault(ctx, userID, vaultID)
	if err != nil {
		return err
	}
	exists, err := s.st.TouchChunks(ctx, vaultID, [][]byte{chunkID})
	if err != nil {
		return err
	}
	if exists[0] {
		return nil
	}
	owner, err := s.st.UserByID(ctx, v.OwnerID)
	if err != nil {
		return fmt.Errorf("load vault owner: %w", err)
	}
	used, err := s.st.UsageBytes(ctx, v.OwnerID)
	if err != nil {
		return err
	}
	if used+size > owner.QuotaBytes {
		return apperr.New(apperr.QuotaExceeded, "storage quota exceeded")
	}

	key := blobKey(vaultID)
	counted := &countingReader{r: io.LimitReader(body, size+1)}
	if err := s.blobs.Put(ctx, key, counted); err != nil {
		return fmt.Errorf("store chunk: %w", err)
	}
	if counted.n != size {
		s.deleteBlob(ctx, key)
		return apperr.New(apperr.Invalid, "chunk body was not the declared %d bytes", size)
	}
	inserted, err := s.st.InsertChunk(ctx, store.Chunk{VaultID: vaultID, ChunkID: chunkID, BlobKey: key, Size: size})
	if err != nil {
		s.deleteBlob(ctx, key)
		return err
	}
	if !inserted {
		s.deleteBlob(ctx, key) // a concurrent upload of the same chunk won
	}
	return nil
}

func (s *Service) OpenChunk(ctx context.Context, userID, vaultID string, chunkID []byte) (io.ReadCloser, error) {
	if len(chunkID) != chunkIDLen {
		return nil, apperr.New(apperr.Invalid, "chunk id must be %d bytes", chunkIDLen)
	}
	if _, err := s.vault(ctx, userID, vaultID); err != nil {
		return nil, err
	}
	key, err := s.st.ChunkBlobKey(ctx, vaultID, chunkID)
	if errors.Is(err, store.ErrNotFound) {
		return nil, apperr.New(apperr.NotFound, "chunk not found")
	}
	if err != nil {
		return nil, err
	}
	rc, err := s.blobs.Get(ctx, key)
	if errors.Is(err, blob.ErrNotFound) {
		return nil, apperr.New(apperr.NotFound, "chunk not found")
	}
	return rc, err
}

type CommitResult struct {
	FileID        []byte
	Seq           int64
	Err           *apperr.Error // nil when the commit was accepted
	HeadVersionID []byte        // the current head, with a Conflict error
}

// Commit applies each commit independently and returns one result per
// commit plus the vault's seq afterwards. Accepted commits notify the vault's
// subscribers once, with the highest new seq.
func (s *Service) Commit(ctx context.Context, userID, deviceID, vaultID string, commits []store.Version) ([]CommitResult, int64, error) {
	if len(commits) == 0 || len(commits) > MaxCommitsPerRequest {
		return nil, 0, apperr.New(apperr.Invalid, "send between 1 and %d commits", MaxCommitsPerRequest)
	}
	v, err := s.vault(ctx, userID, vaultID)
	if err != nil {
		return nil, 0, err
	}
	results := make([]CommitResult, len(commits))
	var newest int64
	for i, c := range commits {
		results[i].FileID = c.FileID
		if verr := s.validateCommit(c); verr != nil {
			results[i].Err = verr
			continue
		}
		c.VaultID = vaultID
		c.DeviceID = deviceID
		out, err := s.st.Commit(ctx, c)
		if err != nil {
			return nil, 0, fmt.Errorf("commit: %w", err)
		}
		switch out.Reason {
		case store.CommitOK:
			results[i].Seq = out.Seq
			newest = max(newest, out.Seq)
		case store.CommitConflict:
			results[i].Err = apperr.New(apperr.Conflict, "the file changed since the base version")
			results[i].HeadVersionID = out.HeadVersionID
		case store.CommitStaleEpoch:
			results[i].Err = apperr.New(apperr.StaleEpoch, "the vault key epoch has changed")
		case store.CommitMissingChunk:
			results[i].Err = apperr.New(apperr.MissingChunk, "a referenced chunk is not on the server; upload it again")
		default:
			results[i].Err = apperr.New(apperr.Invalid, "%s", out.Detail)
		}
	}
	vaultSeq := max(v.Seq, newest)
	if newest > 0 {
		if err := s.bus.Publish(ctx, bus.Notify{VaultID: vaultID, Seq: newest}); err != nil {
			// Clients still converge through their next pull or reconcile.
			s.log.Error("publish notification", "vault", vaultID, "err", err)
		}
	}
	return results, vaultSeq, nil
}

func (s *Service) validateCommit(c store.Version) *apperr.Error {
	maxChunks := int(s.limits.MaxFileSizeBytes/ChunkSize) + 1
	switch {
	case len(c.FileID) != fileIDLen:
		return apperr.New(apperr.Invalid, "file_id must be %d bytes", fileIDLen)
	case len(c.VersionID) != versionIDLen:
		return apperr.New(apperr.Invalid, "version_id must be %d bytes", versionIDLen)
	case len(c.BaseVersionID) != 0 && len(c.BaseVersionID) != versionIDLen:
		return apperr.New(apperr.Invalid, "base_version_id must be empty or %d bytes", versionIDLen)
	case c.Epoch < 1:
		return apperr.New(apperr.Invalid, "epoch must be at least 1")
	case len(c.EncMeta) == 0 || len(c.EncMeta) > MaxEncMetaBytes:
		return apperr.New(apperr.Invalid, "enc_meta must be 1 to %d bytes", MaxEncMetaBytes)
	case c.Size < 0:
		return apperr.New(apperr.Invalid, "size must not be negative")
	case c.Size > s.limits.MaxFileSizeBytes:
		return apperr.New(apperr.TooLarge, "file exceeds the %d byte limit", s.limits.MaxFileSizeBytes)
	case c.Deleted && (len(c.ChunkIDs) > 0 || c.Size != 0):
		return apperr.New(apperr.Invalid, "a deletion carries no chunks and no size")
	case len(c.ChunkIDs) > maxChunks:
		return apperr.New(apperr.Invalid, "a file has at most %d chunks", maxChunks)
	}
	for _, id := range c.ChunkIDs {
		if len(id) != chunkIDLen {
			return apperr.New(apperr.Invalid, "chunk ids must be %d bytes", chunkIDLen)
		}
	}
	return nil
}

type ChangesPage struct {
	Versions []store.Version
	VaultSeq int64
	More     bool
}

func (s *Service) Changes(ctx context.Context, userID, vaultID string, since int64, limit int) (ChangesPage, error) {
	if since < 0 {
		return ChangesPage{}, apperr.New(apperr.Invalid, "since must not be negative")
	}
	limit = clampLimit(limit, DefaultPageSize, MaxPageSize)
	v, err := s.vault(ctx, userID, vaultID)
	if err != nil {
		return ChangesPage{}, err
	}
	versions, err := s.st.Changes(ctx, vaultID, since, limit)
	if err != nil {
		return ChangesPage{}, err
	}
	seq := v.Seq
	if n := len(versions); n > 0 {
		seq = max(seq, versions[n-1].Seq)
	}
	return ChangesPage{Versions: versions, VaultSeq: seq, More: len(versions) == limit}, nil
}

type HeadsPage struct {
	Heads []store.Head
	More  bool
}

func (s *Service) Heads(ctx context.Context, userID, vaultID string, after []byte, limit int) (HeadsPage, error) {
	if len(after) != 0 && len(after) != fileIDLen {
		return HeadsPage{}, apperr.New(apperr.Invalid, "after must be empty or %d bytes", fileIDLen)
	}
	limit = clampLimit(limit, DefaultHeadsPageSize, MaxHeadsPageSize)
	if _, err := s.vault(ctx, userID, vaultID); err != nil {
		return HeadsPage{}, err
	}
	heads, err := s.st.Heads(ctx, vaultID, after, limit)
	if err != nil {
		return HeadsPage{}, err
	}
	return HeadsPage{Heads: heads, More: len(heads) == limit}, nil
}

func (s *Service) History(ctx context.Context, userID, vaultID string, fileID []byte) ([]store.Version, error) {
	if len(fileID) != fileIDLen {
		return nil, apperr.New(apperr.Invalid, "file id must be %d bytes", fileIDLen)
	}
	if _, err := s.vault(ctx, userID, vaultID); err != nil {
		return nil, err
	}
	return s.st.History(ctx, vaultID, fileID)
}

func (s *Service) Trash(ctx context.Context, userID, vaultID string) ([]store.Version, error) {
	if _, err := s.vault(ctx, userID, vaultID); err != nil {
		return nil, err
	}
	return s.st.Trash(ctx, vaultID)
}

func (s *Service) deleteBlob(ctx context.Context, key string) {
	if err := s.blobs.Delete(ctx, key); err != nil {
		s.log.Warn("delete orphaned blob", "blob_key", key, "err", err)
	}
}

// blobKey is unique per upload: <vault>/<2 hex>/<32 hex>.
func blobKey(vaultID string) string {
	h := hex.EncodeToString(ids.Bytes(16))
	return vaultID + "/" + h[:2] + "/" + h
}

func clampLimit(n, def, maxN int) int {
	if n <= 0 {
		return def
	}
	return min(n, maxN)
}

type countingReader struct {
	r io.Reader
	n int64
}

func (c *countingReader) Read(p []byte) (int, error) {
	n, err := c.r.Read(p)
	c.n += int64(n)
	return n, err
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd server && go test -race ./internal/syncsvc/`
Expected: `ok`

- [ ] **Step 5: Commit**

```bash
git add server/internal/syncsvc
git commit -m "feat(sync): chunk upload with quota, commits with notifications, change log paging

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 12: HTTP API foundation: codec, errors, auth, devices, keys, health

**Files:**
- Create: `server/internal/api/server.go`, `server/internal/api/codec.go`, `server/internal/api/auth.go`, `server/internal/api/keys.go`
- Test: `server/internal/api/helpers_test.go`, `server/internal/api/auth_test.go`

**Interfaces:**
- Consumes: `auth.Service`, `auth.Session`, `auth.ErrUnauthorized` (Task 10), `syncsvc.Service` (Task 11), `store` types (Tasks 4–5), `apperr` (Task 10), `obsyncv1` (Task 1).
- Produces:
  ```go
  type Store interface {
      ListDevices(ctx context.Context, userID string) ([]store.Device, error)
      RevokeDevice(ctx context.Context, userID, deviceID string) error
      KeyBundle(ctx context.Context, userID string) (store.KeyBundle, error)
      PutKeyBundle(ctx context.Context, userID string, kb store.KeyBundle) error
      CreateVault(ctx context.Context, v store.Vault, keys []store.VaultKey) error
      ListVaults(ctx context.Context, userID string) ([]store.Vault, error)
      VaultForMember(ctx context.Context, vaultID, userID string) (store.Vault, error)
      VaultKeys(ctx context.Context, vaultID, userID string) ([]store.VaultKey, error)
  }
  type Deps struct {
      Auth  *auth.Service
      Sync  *syncsvc.Service
      Store Store
      Hub   http.Handler                     // mounted at GET /v1/ws when non-nil
      Ready func(ctx context.Context) error  // backs /readyz
      Log   *slog.Logger
  }
  func NewHandler(d Deps) http.Handler
  ```
- Routes added in this task:

  | Route | Auth | Body in | Body out |
  |---|---|---|---|
  | `GET /healthz` | – | – | `200 ok` |
  | `GET /readyz` | – | – | `200 ok` or `503` |
  | `POST /v1/auth/login` | – | `LoginRequest` | `LoginResponse` |
  | `POST /v1/auth/logout` | bearer | – | `204` (revokes the current device) |
  | `GET /v1/devices` | bearer | – | `ListDevicesResponse` |
  | `DELETE /v1/devices/{device}` | bearer | – | `204` |
  | `GET /v1/keys` | bearer | – | `KeyBundle` or `404` |
  | `PUT /v1/keys` | bearer | `KeyBundle` | `204` |

- Error responses have an HTTP status plus an `Error` message body:

  | Status | Error codes |
  |---|---|
  | 400 | `INVALID`, `MISSING_CHUNK` |
  | 401 | `UNAUTHORIZED`, `DEVICE_REVOKED` |
  | 404 | `NOT_FOUND` |
  | 409 | `CONFLICT`, `STALE_EPOCH` |
  | 413 | `TOO_LARGE` |
  | 429 | `RATE_LIMITED` |
  | 507 | `QUOTA_EXCEEDED` |
  | 500 | anything else (the real error is logged, never sent) |

- [ ] **Step 1: Write the test helpers and failing tests**

`server/internal/api/helpers_test.go`:
```go
package api_test

import (
	"bytes"
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"

	"google.golang.org/protobuf/proto"

	"github.com/jfms7s/obsidian-sync/server/internal/api"
	"github.com/jfms7s/obsidian-sync/server/internal/auth"
	"github.com/jfms7s/obsidian-sync/server/internal/blob"
	"github.com/jfms7s/obsidian-sync/server/internal/bus"
	obsyncv1 "github.com/jfms7s/obsidian-sync/server/internal/gen/obsync/v1"
	"github.com/jfms7s/obsidian-sync/server/internal/ids"
	"github.com/jfms7s/obsidian-sync/server/internal/store"
	"github.com/jfms7s/obsidian-sync/server/internal/store/storetest"
	"github.com/jfms7s/obsidian-sync/server/internal/syncsvc"
)

var ctx = context.Background()

type testEnv struct {
	t   *testing.T
	url string
	st  *store.Store
}

func newTestEnv(t *testing.T) *testEnv {
	t.Helper()
	st, clk := storetest.New(t)
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	authSvc, err := auth.NewService(st, auth.Options{Params: auth.FastParams, Now: clk.Now})
	if err != nil {
		t.Fatal(err)
	}
	blobs, err := blob.NewFS(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	syncSvc := syncsvc.New(st, blobs, bus.NewMemory(), syncsvc.Limits{MaxFileSizeBytes: 64 << 20}, log)
	h := api.NewHandler(api.Deps{Auth: authSvc, Sync: syncSvc, Store: st, Ready: st.Ping, Log: log})
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	return &testEnv{t: t, url: srv.URL, st: st}
}

func (e *testEnv) createUser(username, password string) store.User {
	e.t.Helper()
	hash, err := auth.HashPassword(password, auth.FastParams)
	if err != nil {
		e.t.Fatal(err)
	}
	u := store.User{ID: ids.New(), Username: username, PasswordHash: hash, QuotaBytes: 1 << 30}
	if err := e.st.CreateUser(ctx, u); err != nil {
		e.t.Fatal(err)
	}
	return u
}

// login returns a fresh device token for username.
func (e *testEnv) login(username, password string) (token, deviceID string) {
	e.t.Helper()
	var resp obsyncv1.LoginResponse
	status, apiErr := e.do("POST", "/v1/auth/login", "", &obsyncv1.LoginRequest{
		Username: username, Password: password, DeviceName: "laptop", Platform: "linux",
	}, &resp)
	if status != http.StatusOK {
		e.t.Fatalf("login: %d %v", status, apiErr)
	}
	return resp.Token, resp.DeviceId
}

// do sends a protobuf request (in may be nil) and decodes a 2xx response into
// out (may be nil) or an error response into the returned *obsyncv1.Error.
func (e *testEnv) do(method, path, token string, in, out proto.Message) (int, *obsyncv1.Error) {
	e.t.Helper()
	var body []byte
	if in != nil {
		var err error
		if body, err = proto.Marshal(in); err != nil {
			e.t.Fatal(err)
		}
	}
	status, data := e.doRaw(method, path, token, body)
	if status >= 300 {
		var apiErr obsyncv1.Error
		if err := proto.Unmarshal(data, &apiErr); err != nil {
			e.t.Fatalf("%s %s: status %d with undecodable body %q", method, path, status, data)
		}
		return status, &apiErr
	}
	if out != nil {
		if err := proto.Unmarshal(data, out); err != nil {
			e.t.Fatalf("%s %s: decode response: %v", method, path, err)
		}
	}
	return status, nil
}

func (e *testEnv) doRaw(method, path, token string, body []byte) (int, []byte) {
	e.t.Helper()
	var r io.Reader
	if body != nil {
		r = bytes.NewReader(body)
	}
	req, err := http.NewRequest(method, e.url+path, r)
	if err != nil {
		e.t.Fatal(err)
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		e.t.Fatal(err)
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		e.t.Fatal(err)
	}
	return resp.StatusCode, data
}

func wantErr(t *testing.T, status int, apiErr *obsyncv1.Error, wantStatus int, wantCode obsyncv1.ErrorCode) {
	t.Helper()
	if status != wantStatus || apiErr == nil || apiErr.Code != wantCode {
		t.Fatalf("got %d %v, want %d %v", status, apiErr, wantStatus, wantCode)
	}
}
```

`server/internal/api/auth_test.go`:
```go
package api_test

import (
	"bytes"
	"net/http"
	"testing"

	"google.golang.org/protobuf/proto"

	"github.com/jfms7s/obsidian-sync/server/internal/apperr"
	obsyncv1 "github.com/jfms7s/obsidian-sync/server/internal/gen/obsync/v1"
)

func TestHealth(t *testing.T) {
	e := newTestEnv(t)
	for _, path := range []string{"/healthz", "/readyz"} {
		if status, body := e.doRaw("GET", path, "", nil); status != 200 || string(body) != "ok" {
			t.Errorf("%s = %d %q", path, status, body)
		}
	}
}

func TestLoginAndListDevices(t *testing.T) {
	e := newTestEnv(t)
	e.createUser("alice", "correct horse")
	token, deviceID := e.login("alice", "correct horse")

	var list obsyncv1.ListDevicesResponse
	if status, apiErr := e.do("GET", "/v1/devices", token, nil, &list); status != 200 {
		t.Fatalf("%d %v", status, apiErr)
	}
	if len(list.Devices) != 1 || list.Devices[0].DeviceId != deviceID || !list.Devices[0].Current || list.Devices[0].Name != "laptop" {
		t.Fatalf("devices = %v", list.Devices)
	}
}

func TestAuthFailures(t *testing.T) {
	e := newTestEnv(t)
	e.createUser("alice", "correct horse")

	status, apiErr := e.do("POST", "/v1/auth/login", "", &obsyncv1.LoginRequest{Username: "alice", Password: "nope"}, nil)
	wantErr(t, status, apiErr, 401, apperr.Unauthorized)

	status, apiErr = e.do("GET", "/v1/devices", "", nil, nil)
	wantErr(t, status, apiErr, 401, apperr.Unauthorized)

	status, apiErr = e.do("GET", "/v1/devices", "made-up", nil, nil)
	wantErr(t, status, apiErr, 401, apperr.Unauthorized)

	status, body := e.doRaw("POST", "/v1/auth/login", "", []byte{0xff, 0xff, 0xff})
	if status != 400 {
		t.Fatalf("garbage body = %d %q", status, body)
	}
}

func TestRevokeAndLogout(t *testing.T) {
	e := newTestEnv(t)
	e.createUser("alice", "correct horse")
	laptop, _ := e.login("alice", "correct horse")
	phone, phoneID := e.login("alice", "correct horse")

	if status, apiErr := e.do("DELETE", "/v1/devices/"+phoneID, laptop, nil, nil); status != http.StatusNoContent {
		t.Fatalf("revoke = %d %v", status, apiErr)
	}
	status, apiErr := e.do("GET", "/v1/devices", phone, nil, nil)
	wantErr(t, status, apiErr, 401, apperr.DeviceRevoked)

	status, apiErr = e.do("DELETE", "/v1/devices/"+"00000000000000000000000000000000", laptop, nil, nil)
	wantErr(t, status, apiErr, 404, apperr.NotFound)

	if status, _ := e.do("POST", "/v1/auth/logout", laptop, nil, nil); status != http.StatusNoContent {
		t.Fatalf("logout = %d", status)
	}
	status, apiErr = e.do("GET", "/v1/devices", laptop, nil, nil)
	wantErr(t, status, apiErr, 401, apperr.DeviceRevoked)
}

func validBundle() *obsyncv1.KeyBundle {
	return &obsyncv1.KeyBundle{
		PublicEncKey:    bytes.Repeat([]byte{1}, 32),
		PublicSignKey:   bytes.Repeat([]byte{2}, 32),
		PassSalt:        bytes.Repeat([]byte{3}, 16),
		PassParams:      &obsyncv1.Argon2Params{MemoryKib: 19456, Iterations: 2, Parallelism: 1},
		PassWrapped:     []byte("wrapped-by-passphrase"),
		RecoveryWrapped: []byte("wrapped-by-recovery-key"),
	}
}

func TestKeyBundleRoundTrip(t *testing.T) {
	e := newTestEnv(t)
	e.createUser("alice", "correct horse")
	token, _ := e.login("alice", "correct horse")

	status, apiErr := e.do("GET", "/v1/keys", token, nil, nil)
	wantErr(t, status, apiErr, 404, apperr.NotFound)

	if status, apiErr := e.do("PUT", "/v1/keys", token, validBundle(), nil); status != http.StatusNoContent {
		t.Fatalf("put = %d %v", status, apiErr)
	}
	var got obsyncv1.KeyBundle
	if status, apiErr := e.do("GET", "/v1/keys", token, nil, &got); status != 200 {
		t.Fatalf("get = %d %v", status, apiErr)
	}
	if !proto.Equal(&got, validBundle()) {
		t.Fatalf("got %v", &got)
	}

	changed := validBundle()
	changed.PublicEncKey = bytes.Repeat([]byte{9}, 32)
	status, apiErr = e.do("PUT", "/v1/keys", token, changed, nil)
	wantErr(t, status, apiErr, 400, apperr.Invalid)

	weak := validBundle()
	weak.PassParams.MemoryKib = 64
	status, apiErr = e.do("PUT", "/v1/keys", token, weak, nil)
	wantErr(t, status, apiErr, 400, apperr.Invalid)
}
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd server && go test ./internal/api/`
Expected: FAIL because package `api` does not exist.

- [ ] **Step 3: Implement**

`server/internal/api/codec.go`:
```go
package api

import (
	"errors"
	"io"
	"net/http"

	"google.golang.org/protobuf/proto"

	"github.com/jfms7s/obsidian-sync/server/internal/apperr"
	obsyncv1 "github.com/jfms7s/obsidian-sync/server/internal/gen/obsync/v1"
)

const (
	protoContentType  = "application/x-protobuf"
	maxProtoBodyBytes = 8 << 20
)

func readProto(w http.ResponseWriter, r *http.Request, m proto.Message) error {
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxProtoBodyBytes))
	if err != nil {
		var tooBig *http.MaxBytesError
		if errors.As(err, &tooBig) {
			return apperr.New(apperr.TooLarge, "request body exceeds %d bytes", maxProtoBodyBytes)
		}
		return apperr.New(apperr.Invalid, "could not read the request body")
	}
	if err := proto.Unmarshal(body, m); err != nil {
		return apperr.New(apperr.Invalid, "request body is not a valid %s", m.ProtoReflect().Descriptor().Name())
	}
	return nil
}

func writeProto(w http.ResponseWriter, status int, m proto.Message) {
	data, err := proto.Marshal(m)
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", protoContentType)
	w.WriteHeader(status)
	_, _ = w.Write(data)
}

func statusFor(code obsyncv1.ErrorCode) int {
	switch code {
	case apperr.Invalid, apperr.MissingChunk:
		return http.StatusBadRequest
	case apperr.Unauthorized, apperr.DeviceRevoked:
		return http.StatusUnauthorized
	case apperr.NotFound:
		return http.StatusNotFound
	case apperr.Conflict, apperr.StaleEpoch:
		return http.StatusConflict
	case apperr.TooLarge:
		return http.StatusRequestEntityTooLarge
	case apperr.RateLimited:
		return http.StatusTooManyRequests
	case apperr.QuotaExceeded:
		return http.StatusInsufficientStorage
	default:
		return http.StatusInternalServerError
	}
}

// writeError sends err to the client. Errors that are not *apperr.Error are
// infrastructure failures: they are logged and the client sees only INTERNAL.
func (h *handlers) writeError(w http.ResponseWriter, r *http.Request, err error) {
	var ae *apperr.Error
	if !errors.As(err, &ae) {
		h.log.Error("request failed", "method", r.Method, "path", r.URL.Path, "err", err)
		ae = apperr.New(apperr.Internal, "internal error")
	}
	writeProto(w, statusFor(ae.Code), &obsyncv1.Error{Code: ae.Code, Message: ae.Msg})
}
```

`server/internal/api/server.go`:
```go
// Package api exposes obsync over HTTP. Handlers only decode, call a
// service or the store, and encode; rules live in the services.
package api

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"strings"

	"github.com/jfms7s/obsidian-sync/server/internal/apperr"
	"github.com/jfms7s/obsidian-sync/server/internal/auth"
	"github.com/jfms7s/obsidian-sync/server/internal/store"
	"github.com/jfms7s/obsidian-sync/server/internal/syncsvc"
)

type Store interface {
	ListDevices(ctx context.Context, userID string) ([]store.Device, error)
	RevokeDevice(ctx context.Context, userID, deviceID string) error
	KeyBundle(ctx context.Context, userID string) (store.KeyBundle, error)
	PutKeyBundle(ctx context.Context, userID string, kb store.KeyBundle) error
	CreateVault(ctx context.Context, v store.Vault, keys []store.VaultKey) error
	ListVaults(ctx context.Context, userID string) ([]store.Vault, error)
	VaultForMember(ctx context.Context, vaultID, userID string) (store.Vault, error)
	VaultKeys(ctx context.Context, vaultID, userID string) ([]store.VaultKey, error)
}

type Deps struct {
	Auth  *auth.Service
	Sync  *syncsvc.Service
	Store Store
	Hub   http.Handler
	Ready func(ctx context.Context) error
	Log   *slog.Logger
}

type handlers struct {
	auth  *auth.Service
	sync  *syncsvc.Service
	store Store
	ready func(ctx context.Context) error
	log   *slog.Logger
}

func NewHandler(d Deps) http.Handler {
	h := &handlers{auth: d.Auth, sync: d.Sync, store: d.Store, ready: d.Ready, log: d.Log}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", h.healthz)
	mux.HandleFunc("GET /readyz", h.readyz)
	mux.HandleFunc("POST /v1/auth/login", h.login)
	mux.HandleFunc("POST /v1/auth/logout", h.authed(h.logout))
	mux.HandleFunc("GET /v1/devices", h.authed(h.listDevices))
	mux.HandleFunc("DELETE /v1/devices/{device}", h.authed(h.revokeDevice))
	mux.HandleFunc("GET /v1/keys", h.authed(h.getKeys))
	mux.HandleFunc("PUT /v1/keys", h.authed(h.putKeys))
	if d.Hub != nil {
		mux.Handle("GET /v1/ws", d.Hub)
	}
	return h.recoverer(mux)
}

type authedHandler func(w http.ResponseWriter, r *http.Request, sess auth.Session)

func (h *handlers) authed(next authedHandler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		token, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
		if !ok {
			h.writeError(w, r, auth.ErrUnauthorized)
			return
		}
		sess, err := h.auth.Authenticate(r.Context(), token)
		if err != nil {
			h.writeError(w, r, err)
			return
		}
		next(w, r, sess)
	}
}

func (h *handlers) recoverer(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if rec := recover(); rec != nil {
				if rec == http.ErrAbortHandler {
					panic(rec)
				}
				h.log.Error("handler panic", "method", r.Method, "path", r.URL.Path, "panic", fmt.Sprint(rec))
				h.writeError(w, r, apperr.New(apperr.Internal, "internal error"))
			}
		}()
		next.ServeHTTP(w, r)
	})
}

func (h *handlers) healthz(w http.ResponseWriter, _ *http.Request) {
	_, _ = w.Write([]byte("ok"))
}

func (h *handlers) readyz(w http.ResponseWriter, r *http.Request) {
	if err := h.ready(r.Context()); err != nil {
		h.log.Warn("not ready", "err", err)
		http.Error(w, "not ready", http.StatusServiceUnavailable)
		return
	}
	_, _ = w.Write([]byte("ok"))
}
```

`server/internal/api/auth.go`:
```go
package api

import (
	"errors"
	"net/http"

	"github.com/jfms7s/obsidian-sync/server/internal/apperr"
	"github.com/jfms7s/obsidian-sync/server/internal/auth"
	obsyncv1 "github.com/jfms7s/obsidian-sync/server/internal/gen/obsync/v1"
	"github.com/jfms7s/obsidian-sync/server/internal/store"
)

func (h *handlers) login(w http.ResponseWriter, r *http.Request) {
	var req obsyncv1.LoginRequest
	if err := readProto(w, r, &req); err != nil {
		h.writeError(w, r, err)
		return
	}
	res, err := h.auth.Login(r.Context(), auth.LoginRequest{
		Username: req.Username, Password: req.Password, DeviceName: req.DeviceName, Platform: req.Platform,
	})
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	writeProto(w, http.StatusOK, &obsyncv1.LoginResponse{Token: res.Token, DeviceId: res.Device.ID, UserId: res.Device.UserID})
}

func (h *handlers) logout(w http.ResponseWriter, r *http.Request, sess auth.Session) {
	if err := h.store.RevokeDevice(r.Context(), sess.UserID, sess.DeviceID); err != nil {
		h.writeError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *handlers) listDevices(w http.ResponseWriter, r *http.Request, sess auth.Session) {
	devices, err := h.store.ListDevices(r.Context(), sess.UserID)
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	resp := &obsyncv1.ListDevicesResponse{}
	for _, d := range devices {
		resp.Devices = append(resp.Devices, &obsyncv1.Device{
			DeviceId:     d.ID,
			Name:         d.Name,
			Platform:     d.Platform,
			CreatedAtMs:  d.CreatedAtMs,
			LastSeenAtMs: d.LastSeenAtMs,
			Current:      d.ID == sess.DeviceID,
			Revoked:      d.Revoked(),
		})
	}
	writeProto(w, http.StatusOK, resp)
}

func (h *handlers) revokeDevice(w http.ResponseWriter, r *http.Request, sess auth.Session) {
	err := h.store.RevokeDevice(r.Context(), sess.UserID, r.PathValue("device"))
	if errors.Is(err, store.ErrNotFound) {
		h.writeError(w, r, apperr.New(apperr.NotFound, "device not found"))
		return
	}
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
```

`server/internal/api/keys.go`:
```go
package api

import (
	"errors"
	"fmt"
	"net/http"

	"google.golang.org/protobuf/proto"

	"github.com/jfms7s/obsidian-sync/server/internal/apperr"
	"github.com/jfms7s/obsidian-sync/server/internal/auth"
	obsyncv1 "github.com/jfms7s/obsidian-sync/server/internal/gen/obsync/v1"
	"github.com/jfms7s/obsidian-sync/server/internal/store"
)

const maxWrappedKeyBytes = 4096

func (h *handlers) getKeys(w http.ResponseWriter, r *http.Request, sess auth.Session) {
	kb, err := h.store.KeyBundle(r.Context(), sess.UserID)
	if errors.Is(err, store.ErrNotFound) {
		h.writeError(w, r, apperr.New(apperr.NotFound, "no key bundle has been uploaded yet"))
		return
	}
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	var bundle obsyncv1.KeyBundle
	if err := proto.Unmarshal(kb.Bundle, &bundle); err != nil {
		h.writeError(w, r, fmt.Errorf("decode stored key bundle: %w", err))
		return
	}
	writeProto(w, http.StatusOK, &bundle)
}

func (h *handlers) putKeys(w http.ResponseWriter, r *http.Request, sess auth.Session) {
	var kb obsyncv1.KeyBundle
	if err := readProto(w, r, &kb); err != nil {
		h.writeError(w, r, err)
		return
	}
	if err := validateKeyBundle(&kb); err != nil {
		h.writeError(w, r, err)
		return
	}
	data, err := proto.Marshal(&kb)
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	err = h.store.PutKeyBundle(r.Context(), sess.UserID, store.KeyBundle{
		PublicEncKey: kb.PublicEncKey, PublicSignKey: kb.PublicSignKey, Bundle: data,
	})
	if errors.Is(err, store.ErrKeyMismatch) {
		h.writeError(w, r, apperr.New(apperr.Invalid, "public keys cannot be changed"))
		return
	}
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func validateKeyBundle(kb *obsyncv1.KeyBundle) error {
	p := kb.GetPassParams()
	switch {
	case len(kb.PublicEncKey) != 32:
		return apperr.New(apperr.Invalid, "public_enc_key must be 32 bytes")
	case len(kb.PublicSignKey) != 32:
		return apperr.New(apperr.Invalid, "public_sign_key must be 32 bytes")
	case len(kb.PassSalt) < 16 || len(kb.PassSalt) > 64:
		return apperr.New(apperr.Invalid, "pass_salt must be 16 to 64 bytes")
	case p == nil || p.MemoryKib < 8192 || p.Iterations < 1 || p.Parallelism < 1:
		return apperr.New(apperr.Invalid, "pass_params are missing or weaker than 8 MiB / 1 iteration")
	case len(kb.PassWrapped) == 0 || len(kb.PassWrapped) > maxWrappedKeyBytes:
		return apperr.New(apperr.Invalid, "pass_wrapped must be 1 to %d bytes", maxWrappedKeyBytes)
	case len(kb.RecoveryWrapped) == 0 || len(kb.RecoveryWrapped) > maxWrappedKeyBytes:
		return apperr.New(apperr.Invalid, "recovery_wrapped must be 1 to %d bytes", maxWrappedKeyBytes)
	}
	return nil
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd server && go test -race ./internal/api/`
Expected: `ok`

- [ ] **Step 5: Commit**

```bash
git add server/internal/api
git commit -m "feat(api): protobuf HTTP API for login, devices, key bundles and health

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: HTTP API: vaults, chunks and sync endpoints

**Files:**
- Create: `server/internal/api/vaults.go`, `server/internal/api/sync.go`, `server/internal/api/convert.go`
- Modify: `server/internal/api/server.go` (register the vault routes)
- Test: `server/internal/api/vaults_test.go`

**Interfaces:**
- Consumes: everything Task 12 consumes, plus `syncsvc` methods and constants (Task 11), and `ids.Valid` (Task 3).
- Produces these routes. All need a bearer token; `{vault}` is a 32-hex vault ID, and `{chunk}`/`{file}` are 64 hex characters.

  | Route | Body in | Body out |
  |---|---|---|
  | `GET /v1/vaults` | – | `ListVaultsResponse` |
  | `POST /v1/vaults` | `CreateVaultRequest` | `201 Vault` |
  | `GET /v1/vaults/{vault}/keys` | – | `VaultKeysResponse` |
  | `POST /v1/vaults/{vault}/chunks/exists` | `ChunkExistsRequest` | `ChunkExistsResponse` |
  | `PUT /v1/vaults/{vault}/chunks/{chunk}` | raw bytes, `Content-Length` required | `204` |
  | `GET /v1/vaults/{vault}/chunks/{chunk}` | – | raw bytes |
  | `POST /v1/vaults/{vault}/commit` | `CommitRequest` | `CommitResponse` (per-commit results; HTTP 200 even when some commits were rejected) |
  | `GET /v1/vaults/{vault}/changes?since=N&limit=N` | – | `ChangesResponse` |
  | `GET /v1/vaults/{vault}/heads?after=<64 hex>&limit=N` | – | `HeadsResponse` |
  | `GET /v1/vaults/{vault}/files/{file}/history` | – | `VersionsResponse` |
  | `GET /v1/vaults/{vault}/trash` | – | `VersionsResponse` |

- [ ] **Step 1: Write the failing tests**

`server/internal/api/vaults_test.go`:
```go
package api_test

import (
	"bytes"
	"encoding/hex"
	"io"
	"net/http"
	"testing"

	"github.com/jfms7s/obsidian-sync/server/internal/apperr"
	obsyncv1 "github.com/jfms7s/obsidian-sync/server/internal/gen/obsync/v1"
	"github.com/jfms7s/obsidian-sync/server/internal/ids"
)

func (e *testEnv) createVault(token string) string {
	e.t.Helper()
	id := ids.New()
	var v obsyncv1.Vault
	status, apiErr := e.do("POST", "/v1/vaults", token, &obsyncv1.CreateVaultRequest{
		VaultId: id,
		EncName: []byte("encrypted name"),
		Keys:    []*obsyncv1.VaultKey{{Epoch: 0, SealedKey: []byte("naming")}, {Epoch: 1, SealedKey: []byte("epoch1")}},
	}, &v)
	if status != http.StatusCreated {
		e.t.Fatalf("create vault: %d %v", status, apiErr)
	}
	return id
}

func TestVaultLifecycle(t *testing.T) {
	e := newTestEnv(t)
	e.createUser("alice", "correct horse")
	token, _ := e.login("alice", "correct horse")
	id := e.createVault(token)

	var list obsyncv1.ListVaultsResponse
	e.do("GET", "/v1/vaults", token, nil, &list)
	if len(list.Vaults) != 1 || list.Vaults[0].VaultId != id || list.Vaults[0].CurrentEpoch != 1 || string(list.Vaults[0].EncName) != "encrypted name" {
		t.Fatalf("vaults = %v", list.Vaults)
	}
	var keys obsyncv1.VaultKeysResponse
	e.do("GET", "/v1/vaults/"+id+"/keys", token, nil, &keys)
	if len(keys.Keys) != 2 || keys.Keys[0].Epoch != 0 || string(keys.Keys[1].SealedKey) != "epoch1" {
		t.Fatalf("keys = %v", keys.Keys)
	}
	status, apiErr := e.do("POST", "/v1/vaults", token, &obsyncv1.CreateVaultRequest{
		VaultId: id, EncName: []byte("x"),
		Keys:    []*obsyncv1.VaultKey{{Epoch: 0, SealedKey: []byte("a")}, {Epoch: 1, SealedKey: []byte("b")}},
	}, nil)
	wantErr(t, status, apiErr, 400, apperr.Invalid)
}

func TestCreateVaultValidation(t *testing.T) {
	e := newTestEnv(t)
	e.createUser("alice", "correct horse")
	token, _ := e.login("alice", "correct horse")
	keys := []*obsyncv1.VaultKey{{Epoch: 0, SealedKey: []byte("a")}, {Epoch: 1, SealedKey: []byte("b")}}
	for name, req := range map[string]*obsyncv1.CreateVaultRequest{
		"bad id":        {VaultId: "../x", EncName: []byte("n"), Keys: keys},
		"no name":       {VaultId: ids.New(), Keys: keys},
		"missing epoch": {VaultId: ids.New(), EncName: []byte("n"), Keys: keys[:1]},
		"extra epoch":   {VaultId: ids.New(), EncName: []byte("n"), Keys: append(keys, &obsyncv1.VaultKey{Epoch: 2, SealedKey: []byte("c")})},
	} {
		status, apiErr := e.do("POST", "/v1/vaults", token, req, nil)
		if status != 400 || apiErr.Code != apperr.Invalid {
			t.Errorf("%s: %d %v", name, status, apiErr)
		}
	}
}

func TestSyncFlow(t *testing.T) {
	e := newTestEnv(t)
	e.createUser("alice", "correct horse")
	token, deviceID := e.login("alice", "correct horse")
	vault := e.createVault(token)
	base := "/v1/vaults/" + vault
	chunkID := bytes.Repeat([]byte{0xab}, 32)
	chunkHex := hex.EncodeToString(chunkID)
	fileID := bytes.Repeat([]byte{0x01}, 32)

	var exists obsyncv1.ChunkExistsResponse
	e.do("POST", base+"/chunks/exists", token, &obsyncv1.ChunkExistsRequest{ChunkIds: [][]byte{chunkID}}, &exists)
	if len(exists.Exists) != 1 || exists.Exists[0] {
		t.Fatalf("exists before upload = %v", exists.Exists)
	}
	if status, body := e.doRaw("PUT", base+"/chunks/"+chunkHex, token, []byte("ciphertext")); status != http.StatusNoContent {
		t.Fatalf("put chunk = %d %q", status, body)
	}
	e.do("POST", base+"/chunks/exists", token, &obsyncv1.ChunkExistsRequest{ChunkIds: [][]byte{chunkID}}, &exists)
	if !exists.Exists[0] {
		t.Fatal("chunk missing after upload")
	}
	if status, body := e.doRaw("GET", base+"/chunks/"+chunkHex, token, nil); status != 200 || string(body) != "ciphertext" {
		t.Fatalf("get chunk = %d %q", status, body)
	}

	v1 := ids.Bytes(16)
	var cr obsyncv1.CommitResponse
	e.do("POST", base+"/commit", token, &obsyncv1.CommitRequest{Commits: []*obsyncv1.Commit{{
		FileId: fileID, VersionId: v1, Epoch: 1, EncMeta: []byte("meta"), ChunkIds: [][]byte{chunkID}, Size: 10,
	}}}, &cr)
	if len(cr.Results) != 1 || !cr.Results[0].Ok || cr.Results[0].Seq != 1 || cr.VaultSeq != 1 {
		t.Fatalf("commit = %v", &cr)
	}

	var changes obsyncv1.ChangesResponse
	e.do("GET", base+"/changes?since=0", token, nil, &changes)
	if len(changes.Versions) != 1 || changes.More || changes.VaultSeq != 1 {
		t.Fatalf("changes = %v", &changes)
	}
	got := changes.Versions[0]
	if !bytes.Equal(got.VersionId, v1) || got.DeviceId != deviceID || len(got.ChunkIds) != 1 || got.Size != 10 || got.Seq != 1 {
		t.Fatalf("version = %v", got)
	}

	var heads obsyncv1.HeadsResponse
	e.do("GET", base+"/heads", token, nil, &heads)
	if len(heads.Heads) != 1 || !bytes.Equal(heads.Heads[0].VersionId, v1) {
		t.Fatalf("heads = %v", heads.Heads)
	}

	// A second device that never saw v1 also creates the file: conflict.
	e.do("POST", base+"/commit", token, &obsyncv1.CommitRequest{Commits: []*obsyncv1.Commit{{
		FileId: fileID, VersionId: ids.Bytes(16), Epoch: 1, EncMeta: []byte("meta"),
	}}}, &cr)
	if cr.Results[0].Ok || cr.Results[0].Error.Code != apperr.Conflict || !bytes.Equal(cr.Results[0].HeadVersionId, v1) {
		t.Fatalf("conflict result = %v", cr.Results[0])
	}

	// Delete, then the file shows in the trash and has two history entries.
	e.do("POST", base+"/commit", token, &obsyncv1.CommitRequest{Commits: []*obsyncv1.Commit{{
		FileId: fileID, VersionId: ids.Bytes(16), BaseVersionId: v1, Epoch: 1, EncMeta: []byte("meta"), Deleted: true,
	}}}, &cr)
	if !cr.Results[0].Ok || cr.Results[0].Seq != 2 {
		t.Fatalf("delete = %v", cr.Results[0])
	}
	var trash obsyncv1.VersionsResponse
	e.do("GET", base+"/trash", token, nil, &trash)
	if len(trash.Versions) != 1 || !trash.Versions[0].Deleted {
		t.Fatalf("trash = %v", trash.Versions)
	}
	var hist obsyncv1.VersionsResponse
	e.do("GET", base+"/files/"+hex.EncodeToString(fileID)+"/history", token, nil, &hist)
	if len(hist.Versions) != 2 || !hist.Versions[0].Deleted {
		t.Fatalf("history = %v", hist.Versions)
	}
}

func TestOtherUsersCannotReachAVault(t *testing.T) {
	e := newTestEnv(t)
	e.createUser("alice", "correct horse")
	e.createUser("bob", "battery staple")
	alice, _ := e.login("alice", "correct horse")
	bob, _ := e.login("bob", "battery staple")
	vault := e.createVault(alice)
	chunkHex := hex.EncodeToString(bytes.Repeat([]byte{1}, 32))

	for _, path := range []string{"/keys", "/changes", "/heads", "/trash", "/chunks/" + chunkHex} {
		status, apiErr := e.do("GET", "/v1/vaults/"+vault+path, bob, nil, nil)
		if status != 404 || apiErr.Code != apperr.NotFound {
			t.Errorf("GET %s = %d %v", path, status, apiErr)
		}
	}
	if status, _ := e.doRaw("PUT", "/v1/vaults/"+vault+"/chunks/"+chunkHex, bob, []byte("x")); status != 404 {
		t.Errorf("PUT chunk = %d", status)
	}
}

func TestRequestValidation(t *testing.T) {
	e := newTestEnv(t)
	e.createUser("alice", "correct horse")
	token, _ := e.login("alice", "correct horse")
	vault := e.createVault(token)
	base := "/v1/vaults/" + vault

	if status, _ := e.doRaw("GET", base+"/changes?since=abc", token, nil); status != 400 {
		t.Errorf("bad since = %d", status)
	}
	if status, _ := e.doRaw("GET", base+"/heads?after=zz", token, nil); status != 400 {
		t.Errorf("bad after = %d", status)
	}
	if status, _ := e.doRaw("PUT", base+"/chunks/abc", token, []byte("x")); status != 400 {
		t.Errorf("bad chunk id = %d", status)
	}

	// A streamed body has no Content-Length.
	pr, pw := io.Pipe()
	go func() { pw.Write([]byte("data")); pw.Close() }()
	req, _ := http.NewRequest("PUT", e.url+base+"/chunks/"+hex.EncodeToString(bytes.Repeat([]byte{2}, 32)), pr)
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 400 {
		t.Errorf("chunked upload = %d, want 400", resp.StatusCode)
	}
}
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd server && go test ./internal/api/`
Expected: FAIL: the create-vault request gets `404 page not found`, so `createVault` fails the test.

- [ ] **Step 3: Implement**

`server/internal/api/convert.go`:
```go
package api

import (
	obsyncv1 "github.com/jfms7s/obsidian-sync/server/internal/gen/obsync/v1"
	"github.com/jfms7s/obsidian-sync/server/internal/store"
)

func vaultToProto(v store.Vault) *obsyncv1.Vault {
	return &obsyncv1.Vault{
		VaultId:      v.ID,
		EncName:      v.EncName,
		CurrentEpoch: uint32(v.CurrentEpoch),
		Seq:          uint64(v.Seq),
		CreatedAtMs:  v.CreatedAtMs,
		OwnerId:      v.OwnerID,
	}
}

func versionToProto(v store.Version) *obsyncv1.Version {
	return &obsyncv1.Version{
		FileId:        v.FileID,
		VersionId:     v.VersionID,
		BaseVersionId: v.BaseVersionID,
		Epoch:         uint32(v.Epoch),
		EncMeta:       v.EncMeta,
		ChunkIds:      v.ChunkIDs,
		Size:          uint64(v.Size),
		Deleted:       v.Deleted,
		DeviceId:      v.DeviceID,
		CreatedAtMs:   v.CreatedAtMs,
		Seq:           uint64(v.Seq),
	}
}

func versionsToProto(vs []store.Version) *obsyncv1.VersionsResponse {
	resp := &obsyncv1.VersionsResponse{}
	for _, v := range vs {
		resp.Versions = append(resp.Versions, versionToProto(v))
	}
	return resp
}

// commitFromProto converts a commit. A size beyond int64 becomes negative and
// is then rejected by validation.
func commitFromProto(c *obsyncv1.Commit) store.Version {
	return store.Version{
		FileID:        c.FileId,
		VersionID:     c.VersionId,
		BaseVersionID: c.BaseVersionId,
		Epoch:         int(c.Epoch),
		EncMeta:       c.EncMeta,
		ChunkIDs:      c.ChunkIds,
		Size:          int64(c.Size),
		Deleted:       c.Deleted,
	}
}
```

`server/internal/api/vaults.go`:
```go
package api

import (
	"errors"
	"net/http"

	"github.com/jfms7s/obsidian-sync/server/internal/apperr"
	"github.com/jfms7s/obsidian-sync/server/internal/auth"
	obsyncv1 "github.com/jfms7s/obsidian-sync/server/internal/gen/obsync/v1"
	"github.com/jfms7s/obsidian-sync/server/internal/ids"
	"github.com/jfms7s/obsidian-sync/server/internal/store"
)

const (
	maxEncNameBytes   = 1024
	maxSealedKeyBytes = 1024
)

func (h *handlers) registerVaultRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/vaults", h.authed(h.listVaults))
	mux.HandleFunc("POST /v1/vaults", h.authed(h.createVault))
	mux.HandleFunc("GET /v1/vaults/{vault}/keys", h.authed(h.vaultKeys))
	mux.HandleFunc("POST /v1/vaults/{vault}/chunks/exists", h.authed(h.chunksExist))
	mux.HandleFunc("PUT /v1/vaults/{vault}/chunks/{chunk}", h.authed(h.putChunk))
	mux.HandleFunc("GET /v1/vaults/{vault}/chunks/{chunk}", h.authed(h.getChunk))
	mux.HandleFunc("POST /v1/vaults/{vault}/commit", h.authed(h.commit))
	mux.HandleFunc("GET /v1/vaults/{vault}/changes", h.authed(h.changes))
	mux.HandleFunc("GET /v1/vaults/{vault}/heads", h.authed(h.heads))
	mux.HandleFunc("GET /v1/vaults/{vault}/files/{file}/history", h.authed(h.history))
	mux.HandleFunc("GET /v1/vaults/{vault}/trash", h.authed(h.trash))
}

func (h *handlers) listVaults(w http.ResponseWriter, r *http.Request, sess auth.Session) {
	vaults, err := h.store.ListVaults(r.Context(), sess.UserID)
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	resp := &obsyncv1.ListVaultsResponse{}
	for _, v := range vaults {
		resp.Vaults = append(resp.Vaults, vaultToProto(v))
	}
	writeProto(w, http.StatusOK, resp)
}

func (h *handlers) createVault(w http.ResponseWriter, r *http.Request, sess auth.Session) {
	var req obsyncv1.CreateVaultRequest
	if err := readProto(w, r, &req); err != nil {
		h.writeError(w, r, err)
		return
	}
	if err := validateCreateVault(&req); err != nil {
		h.writeError(w, r, err)
		return
	}
	keys := make([]store.VaultKey, len(req.Keys))
	for i, k := range req.Keys {
		keys[i] = store.VaultKey{Epoch: int(k.Epoch), SealedKey: k.SealedKey}
	}
	err := h.store.CreateVault(r.Context(), store.Vault{ID: req.VaultId, OwnerID: sess.UserID, EncName: req.EncName}, keys)
	if errors.Is(err, store.ErrExists) {
		h.writeError(w, r, apperr.New(apperr.Invalid, "vault id already exists"))
		return
	}
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	v, err := h.store.VaultForMember(r.Context(), req.VaultId, sess.UserID)
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	writeProto(w, http.StatusCreated, vaultToProto(v))
}

// validateCreateVault requires exactly the naming key (epoch 0) and the first
// content key (epoch 1), both sealed to the creator.
func validateCreateVault(req *obsyncv1.CreateVaultRequest) error {
	if !ids.Valid(req.VaultId) {
		return apperr.New(apperr.Invalid, "vault_id must be 32 lowercase hex characters")
	}
	if len(req.EncName) == 0 || len(req.EncName) > maxEncNameBytes {
		return apperr.New(apperr.Invalid, "enc_name must be 1 to %d bytes", maxEncNameBytes)
	}
	seen := map[uint32]bool{}
	for _, k := range req.Keys {
		if k.Epoch > 1 {
			return apperr.New(apperr.Invalid, "a new vault has only epochs 0 (naming key) and 1")
		}
		if seen[k.Epoch] {
			return apperr.New(apperr.Invalid, "epoch %d appears twice", k.Epoch)
		}
		if len(k.SealedKey) == 0 || len(k.SealedKey) > maxSealedKeyBytes {
			return apperr.New(apperr.Invalid, "sealed keys must be 1 to %d bytes", maxSealedKeyBytes)
		}
		seen[k.Epoch] = true
	}
	if !seen[0] || !seen[1] {
		return apperr.New(apperr.Invalid, "keys for epochs 0 and 1 are required")
	}
	return nil
}

func (h *handlers) vaultKeys(w http.ResponseWriter, r *http.Request, sess auth.Session) {
	vaultID := r.PathValue("vault")
	if _, err := h.store.VaultForMember(r.Context(), vaultID, sess.UserID); errors.Is(err, store.ErrNotFound) {
		h.writeError(w, r, apperr.New(apperr.NotFound, "vault not found"))
		return
	} else if err != nil {
		h.writeError(w, r, err)
		return
	}
	keys, err := h.store.VaultKeys(r.Context(), vaultID, sess.UserID)
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	resp := &obsyncv1.VaultKeysResponse{}
	for _, k := range keys {
		resp.Keys = append(resp.Keys, &obsyncv1.VaultKey{Epoch: uint32(k.Epoch), SealedKey: k.SealedKey})
	}
	writeProto(w, http.StatusOK, resp)
}
```

`server/internal/api/sync.go`:
```go
package api

import (
	"encoding/hex"
	"io"
	"net/http"
	"strconv"

	"github.com/jfms7s/obsidian-sync/server/internal/apperr"
	"github.com/jfms7s/obsidian-sync/server/internal/auth"
	obsyncv1 "github.com/jfms7s/obsidian-sync/server/internal/gen/obsync/v1"
	"github.com/jfms7s/obsidian-sync/server/internal/store"
	"github.com/jfms7s/obsidian-sync/server/internal/syncsvc"
)

// pathID decodes a 64-hex-character path segment into 32 bytes.
func pathID(r *http.Request, name string) ([]byte, error) {
	b, err := hex.DecodeString(r.PathValue(name))
	if err != nil || len(b) != 32 {
		return nil, apperr.New(apperr.Invalid, "%s must be 64 hex characters", name)
	}
	return b, nil
}

// queryInt reads an optional non-negative integer query parameter (0 if absent).
func queryInt(r *http.Request, name string) (int64, error) {
	s := r.URL.Query().Get(name)
	if s == "" {
		return 0, nil
	}
	n, err := strconv.ParseInt(s, 10, 64)
	if err != nil || n < 0 {
		return 0, apperr.New(apperr.Invalid, "%s must be a non-negative integer", name)
	}
	return n, nil
}

func (h *handlers) chunksExist(w http.ResponseWriter, r *http.Request, sess auth.Session) {
	var req obsyncv1.ChunkExistsRequest
	if err := readProto(w, r, &req); err != nil {
		h.writeError(w, r, err)
		return
	}
	exists, err := h.sync.ChunksExist(r.Context(), sess.UserID, r.PathValue("vault"), req.ChunkIds)
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	writeProto(w, http.StatusOK, &obsyncv1.ChunkExistsResponse{Exists: exists})
}

func (h *handlers) putChunk(w http.ResponseWriter, r *http.Request, sess auth.Session) {
	id, err := pathID(r, "chunk")
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	if r.ContentLength < 0 {
		h.writeError(w, r, apperr.New(apperr.Invalid, "Content-Length is required"))
		return
	}
	body := http.MaxBytesReader(w, r.Body, syncsvc.MaxChunkCipherBytes+1)
	if err := h.sync.PutChunk(r.Context(), sess.UserID, r.PathValue("vault"), id, body, r.ContentLength); err != nil {
		h.writeError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *handlers) getChunk(w http.ResponseWriter, r *http.Request, sess auth.Session) {
	id, err := pathID(r, "chunk")
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	rc, err := h.sync.OpenChunk(r.Context(), sess.UserID, r.PathValue("vault"), id)
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	defer rc.Close()
	w.Header().Set("Content-Type", "application/octet-stream")
	w.WriteHeader(http.StatusOK)
	if _, err := io.Copy(w, rc); err != nil {
		h.log.Debug("chunk download interrupted", "err", err)
	}
}

func (h *handlers) commit(w http.ResponseWriter, r *http.Request, sess auth.Session) {
	var req obsyncv1.CommitRequest
	if err := readProto(w, r, &req); err != nil {
		h.writeError(w, r, err)
		return
	}
	versions := make([]store.Version, len(req.Commits))
	for i, c := range req.Commits {
		versions[i] = commitFromProto(c)
	}
	results, vaultSeq, err := h.sync.Commit(r.Context(), sess.UserID, sess.DeviceID, r.PathValue("vault"), versions)
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	resp := &obsyncv1.CommitResponse{VaultSeq: uint64(vaultSeq)}
	for _, res := range results {
		pr := &obsyncv1.CommitResult{FileId: res.FileID, Ok: res.Err == nil, Seq: uint64(res.Seq), HeadVersionId: res.HeadVersionID}
		if res.Err != nil {
			pr.Error = &obsyncv1.Error{Code: res.Err.Code, Message: res.Err.Msg}
		}
		resp.Results = append(resp.Results, pr)
	}
	writeProto(w, http.StatusOK, resp)
}

func (h *handlers) changes(w http.ResponseWriter, r *http.Request, sess auth.Session) {
	since, err := queryInt(r, "since")
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	limit, err := queryInt(r, "limit")
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	page, err := h.sync.Changes(r.Context(), sess.UserID, r.PathValue("vault"), since, int(min(limit, syncsvc.MaxPageSize)))
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	resp := &obsyncv1.ChangesResponse{VaultSeq: uint64(page.VaultSeq), More: page.More}
	for _, v := range page.Versions {
		resp.Versions = append(resp.Versions, versionToProto(v))
	}
	writeProto(w, http.StatusOK, resp)
}

func (h *handlers) heads(w http.ResponseWriter, r *http.Request, sess auth.Session) {
	var after []byte
	if s := r.URL.Query().Get("after"); s != "" {
		b, err := hex.DecodeString(s)
		if err != nil || len(b) != 32 {
			h.writeError(w, r, apperr.New(apperr.Invalid, "after must be 64 hex characters"))
			return
		}
		after = b
	}
	limit, err := queryInt(r, "limit")
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	page, err := h.sync.Heads(r.Context(), sess.UserID, r.PathValue("vault"), after, int(min(limit, syncsvc.MaxHeadsPageSize)))
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	resp := &obsyncv1.HeadsResponse{More: page.More}
	for _, hd := range page.Heads {
		resp.Heads = append(resp.Heads, &obsyncv1.Head{FileId: hd.FileID, VersionId: hd.VersionID, Seq: uint64(hd.Seq), Deleted: hd.Deleted})
	}
	writeProto(w, http.StatusOK, resp)
}

func (h *handlers) history(w http.ResponseWriter, r *http.Request, sess auth.Session) {
	fileID, err := pathID(r, "file")
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	versions, err := h.sync.History(r.Context(), sess.UserID, r.PathValue("vault"), fileID)
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	writeProto(w, http.StatusOK, versionsToProto(versions))
}

func (h *handlers) trash(w http.ResponseWriter, r *http.Request, sess auth.Session) {
	versions, err := h.sync.Trash(r.Context(), sess.UserID, r.PathValue("vault"))
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	writeProto(w, http.StatusOK, versionsToProto(versions))
}
```

In `server/internal/api/server.go`, register the routes in `NewHandler` immediately after the `PUT /v1/keys` line:
```go
	h.registerVaultRoutes(mux)
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd server && go test -race ./internal/api/`
Expected: `ok`

- [ ] **Step 5: Commit**

```bash
git add server/internal/api
git commit -m "feat(api): vault, chunk and change-log endpoints

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 14: WebSocket hub

**Files:**
- Create: `server/internal/hub/hub.go`
- Test: `server/internal/hub/hub_test.go`

**Interfaces:**
- Consumes: `auth.Service.Authenticate`, `auth.Session` (Task 10), `store.Vault`, `store.ErrNotFound` (Task 5), `bus.Bus` (Task 9), `apperr`, `ids` (Tasks 3, 10), `obsyncv1` frames (Task 1).
- Produces:
  ```go
  type Authenticator interface { Authenticate(ctx context.Context, token string) (auth.Session, error) }
  type Vaults interface { VaultForMember(ctx context.Context, vaultID, userID string) (store.Vault, error) }
  type Options struct { AuthTimeout, WriteTimeout time.Duration } // defaults 10s / 10s
  func New(a Authenticator, v Vaults, b bus.Bus, log *slog.Logger, opts Options) *Hub
  func (h *Hub) ServeHTTP(w http.ResponseWriter, r *http.Request)
  ```
- Protocol. All frames are binary Protobuf: `ClientFrame` from the client, `ServerFrame` from the server.
  1. The first client frame must be `Auth{token}` and must arrive within `AuthTimeout`. The server replies `AuthOk`, or sends `Error` and closes.
  2. `Subscribe{vault_ids}` replaces the current subscriptions (at most 100 vaults). For each vault the device can access, the server immediately sends `Notify{vault, current seq}`, then one more `Notify` for each later commit. A vault the device can't access gets an `Error{NOT_FOUND}` frame and the socket stays open.
  3. `Ping{nonce}` re-checks the token and gets `Pong{nonce}`. If the device was revoked in the meantime, the server sends `Error{DEVICE_REVOKED}` and closes. Plan 2's client pings every 30 s.

- [ ] **Step 1: Write the failing tests**

Run: `cd server && go get github.com/coder/websocket@v1.8.12`

`server/internal/hub/hub_test.go`:
```go
package hub_test

import (
	"context"
	"io"
	"log/slog"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"google.golang.org/protobuf/proto"

	"github.com/jfms7s/obsidian-sync/server/internal/apperr"
	"github.com/jfms7s/obsidian-sync/server/internal/auth"
	"github.com/jfms7s/obsidian-sync/server/internal/bus"
	obsyncv1 "github.com/jfms7s/obsidian-sync/server/internal/gen/obsync/v1"
	"github.com/jfms7s/obsidian-sync/server/internal/hub"
	"github.com/jfms7s/obsidian-sync/server/internal/ids"
	"github.com/jfms7s/obsidian-sync/server/internal/store"
	"github.com/jfms7s/obsidian-sync/server/internal/store/storetest"
)

var ctx = context.Background()

type env struct {
	t     *testing.T
	url   string
	st    *store.Store
	bus   *bus.Memory
	auth  *auth.Service
	token string
	dev   store.Device
	vault store.Vault
}

func newEnv(t *testing.T) *env {
	t.Helper()
	st, clk := storetest.New(t)
	authSvc, err := auth.NewService(st, auth.Options{Params: auth.FastParams, Now: clk.Now})
	if err != nil {
		t.Fatal(err)
	}
	hash, _ := auth.HashPassword("pw", auth.FastParams)
	user := store.User{ID: ids.New(), Username: "alice", PasswordHash: hash, QuotaBytes: 1}
	if err := st.CreateUser(ctx, user); err != nil {
		t.Fatal(err)
	}
	res, err := authSvc.Login(ctx, auth.LoginRequest{Username: "alice", Password: "pw"})
	if err != nil {
		t.Fatal(err)
	}
	b := bus.NewMemory()
	h := hub.New(authSvc, st, b, slog.New(slog.NewTextHandler(io.Discard, nil)), hub.Options{AuthTimeout: 200 * time.Millisecond})
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	return &env{t: t, url: "ws" + strings.TrimPrefix(srv.URL, "http"), st: st, bus: b, auth: authSvc,
		token: res.Token, dev: res.Device, vault: storetest.SeedVault(t, st, user.ID)}
}

func (e *env) dial() *websocket.Conn {
	e.t.Helper()
	c, _, err := websocket.Dial(ctx, e.url, nil)
	if err != nil {
		e.t.Fatal(err)
	}
	e.t.Cleanup(func() { c.CloseNow() })
	return c
}

func send(t *testing.T, c *websocket.Conn, f *obsyncv1.ClientFrame) {
	t.Helper()
	data, _ := proto.Marshal(f)
	if err := c.Write(ctx, websocket.MessageBinary, data); err != nil {
		t.Fatal(err)
	}
}

func recv(t *testing.T, c *websocket.Conn) *obsyncv1.ServerFrame {
	t.Helper()
	rctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	_, data, err := c.Read(rctx)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	var f obsyncv1.ServerFrame
	if err := proto.Unmarshal(data, &f); err != nil {
		t.Fatal(err)
	}
	return &f
}

func expectClosed(t *testing.T, c *websocket.Conn) {
	t.Helper()
	rctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	if _, _, err := c.Read(rctx); err == nil {
		t.Fatal("socket still open")
	} else if rctx.Err() != nil {
		t.Fatal("socket not closed in time")
	}
}

func authFrame(token string) *obsyncv1.ClientFrame {
	return &obsyncv1.ClientFrame{Frame: &obsyncv1.ClientFrame_Auth{Auth: &obsyncv1.Auth{Token: token}}}
}

func subscribeFrame(ids ...string) *obsyncv1.ClientFrame {
	return &obsyncv1.ClientFrame{Frame: &obsyncv1.ClientFrame_Subscribe{Subscribe: &obsyncv1.Subscribe{VaultIds: ids}}}
}

func pingFrame(n uint64) *obsyncv1.ClientFrame {
	return &obsyncv1.ClientFrame{Frame: &obsyncv1.ClientFrame_Ping{Ping: &obsyncv1.Ping{Nonce: n}}}
}

func (e *env) authed() *websocket.Conn {
	e.t.Helper()
	c := e.dial()
	send(e.t, c, authFrame(e.token))
	if f := recv(e.t, c); f.GetAuthOk().GetDeviceId() != e.dev.ID {
		e.t.Fatalf("auth reply = %v", f)
	}
	return c
}

func TestUnauthenticatedSocketIsClosed(t *testing.T) {
	e := newEnv(t)
	expectClosed(t, e.dial())
}

func TestBadTokenGetsUnauthorized(t *testing.T) {
	e := newEnv(t)
	c := e.dial()
	send(t, c, authFrame("nope"))
	if f := recv(t, c); f.GetError().GetCode() != apperr.Unauthorized {
		t.Fatalf("frame = %v", f)
	}
	expectClosed(t, c)
}

func TestSubscribeSendsCurrentSeqThenLiveNotifies(t *testing.T) {
	e := newEnv(t)
	c := e.authed()
	send(t, c, subscribeFrame(e.vault.ID))
	if n := recv(t, c).GetNotify(); n.GetVaultId() != e.vault.ID || n.GetSeq() != 0 {
		t.Fatalf("initial notify = %v", n)
	}
	if err := e.bus.Publish(ctx, bus.Notify{VaultID: e.vault.ID, Seq: 5}); err != nil {
		t.Fatal(err)
	}
	if n := recv(t, c).GetNotify(); n.GetSeq() != 5 {
		t.Fatalf("live notify = %v", n)
	}
}

func TestSubscribeToForeignVault(t *testing.T) {
	e := newEnv(t)
	bob := storetest.SeedUser(t, e.st, "bob")
	foreign := storetest.SeedVault(t, e.st, bob.ID)
	c := e.authed()
	send(t, c, subscribeFrame(foreign.ID))
	if f := recv(t, c); f.GetError().GetCode() != apperr.NotFound {
		t.Fatalf("frame = %v", f)
	}
	send(t, c, pingFrame(1))
	if f := recv(t, c); f.GetPong().GetNonce() != 1 {
		t.Fatalf("socket should stay usable, got %v", f)
	}
}

func TestPingRevalidatesToken(t *testing.T) {
	e := newEnv(t)
	c := e.authed()
	send(t, c, pingFrame(7))
	if f := recv(t, c); f.GetPong().GetNonce() != 7 {
		t.Fatalf("frame = %v", f)
	}
	if err := e.st.RevokeDevice(ctx, e.dev.UserID, e.dev.ID); err != nil {
		t.Fatal(err)
	}
	send(t, c, pingFrame(8))
	if f := recv(t, c); f.GetError().GetCode() != apperr.DeviceRevoked {
		t.Fatalf("frame = %v", f)
	}
	expectClosed(t, c)
}
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd server && go test ./internal/hub/`
Expected: FAIL because package `hub` does not exist.

- [ ] **Step 3: Implement**

`server/internal/hub/hub.go`:
```go
// Package hub pushes "vault X reached seq N" to connected devices over
// WebSockets so they pull changes within seconds.
package hub

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/coder/websocket"
	"google.golang.org/protobuf/proto"

	"github.com/jfms7s/obsidian-sync/server/internal/apperr"
	"github.com/jfms7s/obsidian-sync/server/internal/auth"
	"github.com/jfms7s/obsidian-sync/server/internal/bus"
	obsyncv1 "github.com/jfms7s/obsidian-sync/server/internal/gen/obsync/v1"
	"github.com/jfms7s/obsidian-sync/server/internal/ids"
	"github.com/jfms7s/obsidian-sync/server/internal/store"
)

const (
	maxSubscriptions = 100
	maxFrameBytes    = 64 << 10
)

type Authenticator interface {
	Authenticate(ctx context.Context, token string) (auth.Session, error)
}

type Vaults interface {
	VaultForMember(ctx context.Context, vaultID, userID string) (store.Vault, error)
}

type Options struct {
	AuthTimeout  time.Duration
	WriteTimeout time.Duration
}

type Hub struct {
	auth   Authenticator
	vaults Vaults
	bus    bus.Bus
	log    *slog.Logger
	opts   Options
}

func New(a Authenticator, v Vaults, b bus.Bus, log *slog.Logger, opts Options) *Hub {
	if opts.AuthTimeout == 0 {
		opts.AuthTimeout = 10 * time.Second
	}
	if opts.WriteTimeout == 0 {
		opts.WriteTimeout = 10 * time.Second
	}
	return &Hub{auth: a, vaults: v, bus: b, log: log, opts: opts}
}

func (h *Hub) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		// The Origin header is not checked: the socket is authenticated by a
		// token in its first frame, never by cookies, so a cross-origin page
		// gains nothing. Obsidian connects from app://obsidian.md and
		// capacitor://localhost.
		InsecureSkipVerify: true,
	})
	if err != nil {
		return // Accept has already written the HTTP error
	}
	defer ws.CloseNow()
	ws.SetReadLimit(maxFrameBytes)

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	c := &conn{hub: h, ws: ws, ctx: ctx, subs: map[string]func(){}}
	defer c.unsubscribeAll()
	if err := c.run(); err != nil {
		h.log.Debug("websocket closed", "err", err)
	}
}

type conn struct {
	hub   *Hub
	ws    *websocket.Conn
	ctx   context.Context
	token string
	sess  auth.Session

	mu   sync.Mutex
	subs map[string]func() // vault id → bus cancel
}

func (c *conn) run() error {
	if err := c.authenticate(); err != nil {
		return err
	}
	for {
		var f obsyncv1.ClientFrame
		if err := c.read(c.ctx, &f); err != nil {
			return err
		}
		switch m := f.Frame.(type) {
		case *obsyncv1.ClientFrame_Subscribe:
			c.subscribe(m.Subscribe.GetVaultIds())
		case *obsyncv1.ClientFrame_Ping:
			if _, err := c.hub.auth.Authenticate(c.ctx, c.token); err != nil {
				return c.fail(err)
			}
			pong := &obsyncv1.ServerFrame{Frame: &obsyncv1.ServerFrame_Pong{Pong: &obsyncv1.Pong{Nonce: m.Ping.GetNonce()}}}
			if err := c.send(pong); err != nil {
				return err
			}
		default:
			return c.fail(apperr.New(apperr.Invalid, "unexpected frame"))
		}
	}
}

func (c *conn) authenticate() error {
	ctx, cancel := context.WithTimeout(c.ctx, c.hub.opts.AuthTimeout)
	defer cancel()
	var f obsyncv1.ClientFrame
	if err := c.read(ctx, &f); err != nil {
		return err // a cancelled Read closes the socket
	}
	a := f.GetAuth()
	if a == nil {
		return c.fail(apperr.New(apperr.Unauthorized, "the first frame must be auth"))
	}
	sess, err := c.hub.auth.Authenticate(c.ctx, a.GetToken())
	if err != nil {
		return c.fail(err)
	}
	c.token, c.sess = a.GetToken(), sess
	return c.send(&obsyncv1.ServerFrame{Frame: &obsyncv1.ServerFrame_AuthOk{AuthOk: &obsyncv1.AuthOk{DeviceId: sess.DeviceID}}})
}

func (c *conn) read(ctx context.Context, f *obsyncv1.ClientFrame) error {
	typ, data, err := c.ws.Read(ctx)
	if err != nil {
		return err
	}
	if typ != websocket.MessageBinary {
		return c.fail(apperr.New(apperr.Invalid, "frames must be binary"))
	}
	if err := proto.Unmarshal(data, f); err != nil {
		return c.fail(apperr.New(apperr.Invalid, "malformed frame"))
	}
	return nil
}

// subscribe replaces the connection's subscriptions with vaultIDs.
func (c *conn) subscribe(vaultIDs []string) {
	c.unsubscribeAll()
	if len(vaultIDs) > maxSubscriptions {
		c.sendError(apperr.New(apperr.Invalid, "subscribe to at most %d vaults", maxSubscriptions))
		return
	}
	for _, id := range vaultIDs {
		if !ids.Valid(id) {
			c.sendError(apperr.New(apperr.NotFound, "vault %q not found", id))
			continue
		}
		// Subscribe before reading the seq, so a commit landing in between is
		// delivered rather than missed.
		ch, cancel := c.hub.bus.Subscribe(id)
		v, err := c.hub.vaults.VaultForMember(c.ctx, id, c.sess.UserID)
		if err != nil {
			cancel()
			if errors.Is(err, store.ErrNotFound) {
				c.sendError(apperr.New(apperr.NotFound, "vault %s not found", id))
			} else {
				c.hub.log.Error("subscribe", "vault", id, "err", err)
				c.sendError(apperr.New(apperr.Internal, "internal error"))
			}
			continue
		}
		c.mu.Lock()
		c.subs[id] = cancel
		c.mu.Unlock()
		go c.forward(id, v.Seq, ch)
	}
}

func (c *conn) forward(vaultID string, seq int64, ch <-chan bus.Notify) {
	if err := c.sendNotify(vaultID, seq); err != nil {
		return
	}
	for n := range ch {
		if err := c.sendNotify(n.VaultID, n.Seq); err != nil {
			return
		}
	}
}

func (c *conn) unsubscribeAll() {
	c.mu.Lock()
	defer c.mu.Unlock()
	for id, cancel := range c.subs {
		cancel()
		delete(c.subs, id)
	}
}

func (c *conn) sendNotify(vaultID string, seq int64) error {
	return c.send(&obsyncv1.ServerFrame{Frame: &obsyncv1.ServerFrame_Notify{Notify: &obsyncv1.Notify{VaultId: vaultID, Seq: uint64(seq)}}})
}

func (c *conn) sendError(e *apperr.Error) {
	_ = c.send(&obsyncv1.ServerFrame{Frame: &obsyncv1.ServerFrame_Error{Error: &obsyncv1.Error{Code: e.Code, Message: e.Msg}}})
}

// fail reports err to the client as an Error frame and closes the socket.
func (c *conn) fail(err error) error {
	var ae *apperr.Error
	if !errors.As(err, &ae) {
		c.hub.log.Error("websocket", "err", err)
		ae = apperr.New(apperr.Internal, "internal error")
	}
	c.sendError(ae)
	_ = c.ws.Close(websocket.StatusPolicyViolation, ae.Msg)
	return err
}

// send writes one frame. websocket.Conn allows concurrent writers.
func (c *conn) send(f *obsyncv1.ServerFrame) error {
	data, err := proto.Marshal(f)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(c.ctx, c.hub.opts.WriteTimeout)
	defer cancel()
	return c.ws.Write(ctx, websocket.MessageBinary, data)
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd server && go mod tidy && go test -race ./internal/hub/`
Expected: `ok`

- [ ] **Step 5: Commit**

```bash
git add server/go.mod server/go.sum server/internal/hub
git commit -m "feat(hub): authenticated WebSocket change notifications

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 15: Retention and chunk garbage collection

**Files:**
- Create: `server/internal/store/jobs.go`
- Create: `server/internal/jobs/runner.go`
- Test: `server/internal/store/jobs_test.go`, `server/internal/jobs/runner_test.go`

**Interfaces:**
- Consumes: store internals (Tasks 3–7), `blob.Store` (Task 8), `config.Retention` (Task 2), `ids` (Task 3).
- Produces:
  ```go
  // package store
  func (s *Store) AcquireLease(ctx context.Context, name, holder string, ttl time.Duration) (bool, error)
  type PrunePolicy struct { HistoryCutoffMs int64; MaxVersions int; TrashCutoffMs int64 } // MaxVersions 0 = no count limit
  type PruneStats struct { VersionsDeleted, FilesPurged int }
  func (s *Store) Prune(ctx context.Context, p PrunePolicy) (PruneStats, error)
  type DeadChunk struct { VaultID string; ChunkID []byte; BlobKey string; Size int64 }
  func (s *Store) DeadChunks(ctx context.Context, touchedBeforeMs int64, limit int) ([]DeadChunk, error)
  func (s *Store) DeleteDeadChunk(ctx context.Context, c DeadChunk, touchedBeforeMs int64) (bool, error)

  // package jobs
  type Config struct { Interval time.Duration; Retention config.Retention; GCGrace time.Duration }
  func New(st Store, blobs blob.Store, cfg Config, now func() time.Time, log *slog.Logger) *Runner
  func (r *Runner) RunOnce(ctx context.Context) error // no-op if another replica holds the lease
  func (r *Runner) Run(ctx context.Context)            // RunOnce now, then every Interval until ctx ends
  ```
- Pruning rules:
  - **Trash purge:** a file whose head is a tombstone older than `TrashCutoffMs` loses its whole history and its `files` row. It's skipped if the file was re-created since the scan.
  - **Age:** non-head versions older than `HistoryCutoffMs` are deleted.
  - **Count:** with `MaxVersions > 0`, only the newest `MaxVersions` versions of each file are kept.
  - **Heads that aren't tombstones are never pruned.**
- Chunk GC: a chunk is dead when no version references it and its `touched_at` is older than the grace period. The row is deleted (and the vault's usage reduced) in a transaction that re-checks both conditions; the blob is deleted after that.

- [ ] **Step 1: Write the failing tests**

`server/internal/store/jobs_test.go`:
```go
package store_test

import (
	"testing"
	"time"

	"github.com/jfms7s/obsidian-sync/server/internal/store"
	"github.com/jfms7s/obsidian-sync/server/internal/store/storetest"
)

const day = 24 * time.Hour

func TestPruneHistoryByAgeKeepsHeads(t *testing.T) {
	f := newFixture(t)
	v1 := storetest.MustCommit(t, f.st, storetest.NewVersion(f.vault.ID, storetest.FileID(1), nil, storetest.ChunkID(1)))
	lone := storetest.MustCommit(t, f.st, storetest.NewVersion(f.vault.ID, storetest.FileID(2), nil))
	f.clk.Advance(31 * day)
	storetest.MustCommit(t, f.st, storetest.NewVersion(f.vault.ID, storetest.FileID(1), v1.VersionID, storetest.ChunkID(2)))

	stats, err := f.st.Prune(ctx, store.PrunePolicy{HistoryCutoffMs: f.clk.Now().Add(-30 * day).UnixMilli()})
	if err != nil || stats.VersionsDeleted != 1 {
		t.Fatalf("stats = %+v, err %v", stats, err)
	}
	if hist, _ := f.st.History(ctx, f.vault.ID, storetest.FileID(1)); len(hist) != 1 {
		t.Fatalf("file 1 history = %d versions", len(hist))
	}
	if hist, _ := f.st.History(ctx, f.vault.ID, storetest.FileID(2)); len(hist) != 1 || hist[0].Seq != lone.Seq {
		t.Fatalf("an old head was pruned: %+v", hist)
	}
}

func TestPruneMaxVersions(t *testing.T) {
	f := newFixture(t)
	var base []byte
	for i := 0; i < 4; i++ {
		v := storetest.MustCommit(t, f.st, storetest.NewVersion(f.vault.ID, storetest.FileID(1), base))
		base = v.VersionID
	}
	stats, err := f.st.Prune(ctx, store.PrunePolicy{MaxVersions: 2})
	if err != nil || stats.VersionsDeleted != 2 {
		t.Fatalf("stats = %+v, err %v", stats, err)
	}
	hist, _ := f.st.History(ctx, f.vault.ID, storetest.FileID(1))
	if len(hist) != 2 || hist[0].Seq != 4 || hist[1].Seq != 3 {
		t.Fatalf("history = %+v", hist)
	}
}

func TestPurgeTrash(t *testing.T) {
	f := newFixture(t)
	v1 := storetest.MustCommit(t, f.st, storetest.NewVersion(f.vault.ID, storetest.FileID(1), nil, storetest.ChunkID(1)))
	tomb := storetest.NewVersion(f.vault.ID, storetest.FileID(1), v1.VersionID)
	tomb.Deleted = true
	storetest.MustCommit(t, f.st, tomb)

	f.clk.Advance(10 * day)
	stats, _ := f.st.Prune(ctx, store.PrunePolicy{TrashCutoffMs: f.clk.Now().Add(-30 * day).UnixMilli()})
	if stats.FilesPurged != 0 {
		t.Fatal("purged before the trash period ended")
	}

	f.clk.Advance(21 * day)
	stats, err := f.st.Prune(ctx, store.PrunePolicy{TrashCutoffMs: f.clk.Now().Add(-30 * day).UnixMilli()})
	if err != nil || stats.FilesPurged != 1 {
		t.Fatalf("stats = %+v, err %v", stats, err)
	}
	if heads, _ := f.st.Heads(ctx, f.vault.ID, nil, 10); len(heads) != 0 {
		t.Fatalf("heads = %+v", heads)
	}
	if hist, _ := f.st.History(ctx, f.vault.ID, storetest.FileID(1)); len(hist) != 0 {
		t.Fatalf("history = %+v", hist)
	}
	// The path can be created again from scratch.
	storetest.MustCommit(t, f.st, storetest.NewVersion(f.vault.ID, storetest.FileID(1), nil))
}

func TestDeadChunks(t *testing.T) {
	f := newFixture(t) // seeds chunks 1-4 at the fixture's start time
	start := f.clk.Now().UnixMilli()
	storetest.MustCommit(t, f.st, storetest.NewVersion(f.vault.ID, storetest.FileID(1), nil, storetest.ChunkID(1)))

	if dead, _ := f.st.DeadChunks(ctx, start, 10); len(dead) != 0 {
		t.Fatalf("chunks inside the grace period reported dead: %+v", dead)
	}
	dead, err := f.st.DeadChunks(ctx, start+1, 10)
	if err != nil || len(dead) != 3 {
		t.Fatalf("dead = %+v, err %v (want chunks 2-4; chunk 1 is referenced)", dead, err)
	}
	before, _ := f.st.UsageBytes(ctx, f.vault.OwnerID)
	ok, err := f.st.DeleteDeadChunk(ctx, dead[0], start+1)
	if err != nil || !ok {
		t.Fatalf("delete ok=%v err=%v", ok, err)
	}
	if after, _ := f.st.UsageBytes(ctx, f.vault.OwnerID); after != before-dead[0].Size {
		t.Fatalf("usage %d → %d", before, after)
	}
	if ok, _ := f.st.DeleteDeadChunk(ctx, dead[0], start+1); ok {
		t.Fatal("deleted twice")
	}
	// Touching a chunk (an exists-check before commit) rescues it.
	f.clk.Advance(time.Minute)
	f.st.TouchChunks(ctx, f.vault.ID, [][]byte{dead[1].ChunkID})
	if ok, _ := f.st.DeleteDeadChunk(ctx, dead[1], start+1); ok {
		t.Fatal("deleted a chunk that was just touched")
	}
}

func TestAcquireLease(t *testing.T) {
	st, clk := storetest.New(t)
	if ok, err := st.AcquireLease(ctx, "maintenance", "a", time.Minute); err != nil || !ok {
		t.Fatalf("a: ok=%v err=%v", ok, err)
	}
	if ok, _ := st.AcquireLease(ctx, "maintenance", "b", time.Minute); ok {
		t.Fatal("b took a live lease")
	}
	if ok, _ := st.AcquireLease(ctx, "maintenance", "a", time.Minute); !ok {
		t.Fatal("a could not renew")
	}
	clk.Advance(2 * time.Minute)
	if ok, _ := st.AcquireLease(ctx, "maintenance", "b", time.Minute); !ok {
		t.Fatal("b could not take an expired lease")
	}
}
```

`server/internal/jobs/runner_test.go`:
```go
package jobs_test

import (
	"bytes"
	"context"
	"encoding/hex"
	"errors"
	"io"
	"log/slog"
	"testing"
	"time"

	"github.com/jfms7s/obsidian-sync/server/internal/blob"
	"github.com/jfms7s/obsidian-sync/server/internal/config"
	"github.com/jfms7s/obsidian-sync/server/internal/jobs"
	"github.com/jfms7s/obsidian-sync/server/internal/store"
	"github.com/jfms7s/obsidian-sync/server/internal/store/storetest"
)

func TestRunOnceDeletesUnreferencedChunkBlobs(t *testing.T) {
	ctx := context.Background()
	st, clk := storetest.New(t)
	blobs, err := blob.NewFS(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	user := storetest.SeedUser(t, st, "alice")
	vault := storetest.SeedVault(t, st, user.ID)

	putChunk := func(b byte) string {
		key := "test/" + hex.EncodeToString(storetest.ChunkID(b))
		if err := blobs.Put(ctx, key, bytes.NewReader([]byte("cipher"))); err != nil {
			t.Fatal(err)
		}
		if _, err := st.InsertChunk(ctx, store.Chunk{VaultID: vault.ID, ChunkID: storetest.ChunkID(b), BlobKey: key, Size: 6}); err != nil {
			t.Fatal(err)
		}
		return key
	}
	oldKey, newKey := putChunk(1), putChunk(2)
	v1 := storetest.MustCommit(t, st, storetest.NewVersion(vault.ID, storetest.FileID(1), nil, storetest.ChunkID(1)))
	clk.Advance(31 * 24 * time.Hour)
	storetest.MustCommit(t, st, storetest.NewVersion(vault.ID, storetest.FileID(1), v1.VersionID, storetest.ChunkID(2)))

	r := jobs.New(st, blobs, jobs.Config{
		Interval:  time.Hour,
		Retention: config.Retention{HistoryDays: 30, TrashDays: 30},
		GCGrace:   24 * time.Hour,
	}, clk.Now, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err := r.RunOnce(ctx); err != nil {
		t.Fatal(err)
	}

	if _, err := blobs.Get(ctx, oldKey); !errors.Is(err, blob.ErrNotFound) {
		t.Fatalf("old chunk blob survived: %v", err)
	}
	rc, err := blobs.Get(ctx, newKey)
	if err != nil {
		t.Fatalf("live chunk blob deleted: %v", err)
	}
	rc.Close()
	if used, _ := st.UsageBytes(ctx, user.ID); used != 6 {
		t.Fatalf("usage = %d, want 6", used)
	}
}

func TestRunOnceSkipsWhenAnotherReplicaHoldsTheLease(t *testing.T) {
	ctx := context.Background()
	st, clk := storetest.New(t)
	if ok, _ := st.AcquireLease(ctx, "maintenance", "other-replica", time.Hour); !ok {
		t.Fatal("setup: lease not taken")
	}
	blobs, _ := blob.NewFS(t.TempDir())
	r := jobs.New(st, blobs, jobs.Config{Interval: time.Hour, GCGrace: time.Hour}, clk.Now, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err := r.RunOnce(ctx); err != nil {
		t.Fatalf("RunOnce without the lease must be a quiet no-op: %v", err)
	}
}
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd server && go test ./internal/store/ ./internal/jobs/`
Expected: FAIL to compile with `f.st.Prune undefined`, and package `jobs` doesn't exist.

- [ ] **Step 3: Implement the store side**

`server/internal/store/jobs.go`:
```go
package store

import (
	"context"
	"database/sql"
	"fmt"
	"time"
)

// AcquireLease takes or renews the named lease for holder until now+ttl.
// It returns false while another holder's lease is unexpired.
func (s *Store) AcquireLease(ctx context.Context, name, holder string, ttl time.Duration) (bool, error) {
	now := s.nowMs()
	res, err := s.db.ExecContext(ctx,
		`INSERT INTO job_leases (name, holder, expires_at) VALUES (?, ?, ?)
		 ON CONFLICT (name) DO UPDATE SET holder = excluded.holder, expires_at = excluded.expires_at
		 WHERE job_leases.expires_at < ? OR job_leases.holder = excluded.holder`,
		name, holder, now+ttl.Milliseconds(), now)
	if err != nil {
		return false, fmt.Errorf("acquire lease: %w", err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return false, fmt.Errorf("acquire lease: %w", err)
	}
	return n == 1, nil
}

type PrunePolicy struct {
	HistoryCutoffMs int64 // non-head versions created before this are deleted
	MaxVersions     int   // keep at most this many versions per file; 0 = no limit
	TrashCutoffMs   int64 // files deleted before this are purged entirely
}

type PruneStats struct {
	VersionsDeleted int
	FilesPurged     int
}

// notHead matches versions rows that are not their file's current head.
const notHead = `NOT EXISTS (SELECT 1 FROM files f WHERE f.vault_id = versions.vault_id AND f.head_version_id = versions.version_id)`

func (s *Store) Prune(ctx context.Context, p PrunePolicy) (PruneStats, error) {
	var stats PruneStats
	purged, err := s.purgeTrash(ctx, p.TrashCutoffMs)
	if err != nil {
		return stats, err
	}
	stats.FilesPurged = purged

	n, err := s.deleteVersions(ctx, `created_at < ? AND `+notHead, p.HistoryCutoffMs)
	if err != nil {
		return stats, err
	}
	stats.VersionsDeleted += n

	if p.MaxVersions > 0 {
		n, err = s.deleteVersions(ctx,
			`(vault_id, version_id) IN (
			   SELECT vault_id, version_id FROM (
			     SELECT vault_id, version_id,
			            ROW_NUMBER() OVER (PARTITION BY vault_id, file_id ORDER BY seq DESC) AS rn
			     FROM versions)
			   WHERE rn > ?) AND `+notHead, p.MaxVersions)
		if err != nil {
			return stats, err
		}
		stats.VersionsDeleted += n
	}
	return stats, nil
}

// deleteVersions deletes the versions matching where (a predicate over the
// versions table) and their chunk references, in one transaction.
func (s *Store) deleteVersions(ctx context.Context, where string, args ...any) (int, error) {
	var deleted int64
	err := s.withTx(ctx, func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(ctx,
			`DELETE FROM version_chunks WHERE (vault_id, version_id) IN (SELECT vault_id, version_id FROM versions WHERE `+where+`)`,
			args...); err != nil {
			return fmt.Errorf("delete chunk refs: %w", err)
		}
		res, err := tx.ExecContext(ctx, `DELETE FROM versions WHERE `+where, args...)
		if err != nil {
			return fmt.Errorf("delete versions: %w", err)
		}
		deleted, err = res.RowsAffected()
		return err
	})
	return int(deleted), err
}

func (s *Store) purgeTrash(ctx context.Context, cutoffMs int64) (int, error) {
	type target struct {
		vaultID      string
		fileID, head []byte
	}
	rows, err := s.db.QueryContext(ctx,
		`SELECT f.vault_id, f.file_id, f.head_version_id FROM files f
		 JOIN versions v ON v.vault_id = f.vault_id AND v.version_id = f.head_version_id
		 WHERE v.deleted = 1 AND v.created_at < ?`, cutoffMs)
	if err != nil {
		return 0, fmt.Errorf("find expired trash: %w", err)
	}
	var targets []target
	for rows.Next() {
		var tg target
		if err := rows.Scan(&tg.vaultID, &tg.fileID, &tg.head); err != nil {
			rows.Close()
			return 0, fmt.Errorf("scan trash: %w", err)
		}
		targets = append(targets, tg)
	}
	// Close before the transactions below: a local database has one connection.
	if err := rows.Close(); err != nil {
		return 0, err
	}

	purged := 0
	for _, tg := range targets {
		err := s.withTx(ctx, func(tx *sql.Tx) error {
			res, err := tx.ExecContext(ctx,
				`DELETE FROM files WHERE vault_id = ? AND file_id = ? AND head_version_id = ?`, tg.vaultID, tg.fileID, tg.head)
			if err != nil {
				return fmt.Errorf("purge file: %w", err)
			}
			if n, _ := res.RowsAffected(); n == 0 {
				return nil // re-created since the scan
			}
			if _, err := tx.ExecContext(ctx,
				`DELETE FROM version_chunks WHERE vault_id = ? AND version_id IN
				 (SELECT version_id FROM versions WHERE vault_id = ? AND file_id = ?)`,
				tg.vaultID, tg.vaultID, tg.fileID); err != nil {
				return fmt.Errorf("purge chunk refs: %w", err)
			}
			if _, err := tx.ExecContext(ctx,
				`DELETE FROM versions WHERE vault_id = ? AND file_id = ?`, tg.vaultID, tg.fileID); err != nil {
				return fmt.Errorf("purge versions: %w", err)
			}
			purged++
			return nil
		})
		if err != nil {
			return purged, err
		}
	}
	return purged, nil
}

type DeadChunk struct {
	VaultID string
	ChunkID []byte
	BlobKey string
	Size    int64
}

const unreferenced = `NOT EXISTS (SELECT 1 FROM version_chunks vc WHERE vc.vault_id = chunks.vault_id AND vc.chunk_id = chunks.chunk_id)`

// DeadChunks lists up to limit chunks that no version references and that
// were last touched before touchedBeforeMs.
func (s *Store) DeadChunks(ctx context.Context, touchedBeforeMs int64, limit int) ([]DeadChunk, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT vault_id, chunk_id, blob_key, size FROM chunks WHERE touched_at < ? AND `+unreferenced+` LIMIT ?`,
		touchedBeforeMs, limit)
	if err != nil {
		return nil, fmt.Errorf("dead chunks: %w", err)
	}
	defer rows.Close()
	var out []DeadChunk
	for rows.Next() {
		var c DeadChunk
		if err := rows.Scan(&c.VaultID, &c.ChunkID, &c.BlobKey, &c.Size); err != nil {
			return nil, fmt.Errorf("scan dead chunk: %w", err)
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// DeleteDeadChunk deletes c's row if it is still dead and subtracts its size
// from the vault's usage. The caller deletes the blob afterwards.
func (s *Store) DeleteDeadChunk(ctx context.Context, c DeadChunk, touchedBeforeMs int64) (bool, error) {
	var deleted bool
	err := s.withTx(ctx, func(tx *sql.Tx) error {
		res, err := tx.ExecContext(ctx,
			`DELETE FROM chunks WHERE vault_id = ? AND chunk_id = ? AND touched_at < ? AND `+unreferenced,
			c.VaultID, c.ChunkID, touchedBeforeMs)
		if err != nil {
			return fmt.Errorf("delete chunk: %w", err)
		}
		if n, _ := res.RowsAffected(); n == 0 {
			return nil
		}
		deleted = true
		if _, err := tx.ExecContext(ctx,
			`UPDATE vaults SET bytes_used = bytes_used - ? WHERE id = ?`, c.Size, c.VaultID); err != nil {
			return fmt.Errorf("reduce usage: %w", err)
		}
		return nil
	})
	return deleted, err
}
```

- [ ] **Step 4: Implement the runner**

`server/internal/jobs/runner.go`:
```go
// Package jobs runs periodic maintenance: retention pruning, then chunk
// garbage collection. A database lease makes one replica run it at a time.
package jobs

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/jfms7s/obsidian-sync/server/internal/blob"
	"github.com/jfms7s/obsidian-sync/server/internal/config"
	"github.com/jfms7s/obsidian-sync/server/internal/ids"
	"github.com/jfms7s/obsidian-sync/server/internal/store"
)

const (
	leaseName    = "maintenance"
	gcBatch      = 500
	maxGCBatches = 100
)

type Store interface {
	AcquireLease(ctx context.Context, name, holder string, ttl time.Duration) (bool, error)
	Prune(ctx context.Context, p store.PrunePolicy) (store.PruneStats, error)
	DeadChunks(ctx context.Context, touchedBeforeMs int64, limit int) ([]store.DeadChunk, error)
	DeleteDeadChunk(ctx context.Context, c store.DeadChunk, touchedBeforeMs int64) (bool, error)
}

type Config struct {
	Interval  time.Duration
	Retention config.Retention
	GCGrace   time.Duration
}

type Runner struct {
	st     Store
	blobs  blob.Store
	cfg    Config
	holder string
	now    func() time.Time
	log    *slog.Logger
}

func New(st Store, blobs blob.Store, cfg Config, now func() time.Time, log *slog.Logger) *Runner {
	return &Runner{st: st, blobs: blobs, cfg: cfg, holder: ids.New(), now: now, log: log}
}

// Run calls RunOnce immediately and then every Interval until ctx ends.
func (r *Runner) Run(ctx context.Context) {
	ticker := time.NewTicker(r.cfg.Interval)
	defer ticker.Stop()
	for {
		if err := r.RunOnce(ctx); err != nil && ctx.Err() == nil {
			r.log.Error("maintenance failed", "err", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func (r *Runner) RunOnce(ctx context.Context) error {
	ok, err := r.st.AcquireLease(ctx, leaseName, r.holder, 2*r.cfg.Interval)
	if err != nil {
		return fmt.Errorf("acquire lease: %w", err)
	}
	if !ok {
		return nil
	}
	now := r.now()
	day := 24 * time.Hour
	stats, err := r.st.Prune(ctx, store.PrunePolicy{
		HistoryCutoffMs: now.Add(-time.Duration(r.cfg.Retention.HistoryDays) * day).UnixMilli(),
		MaxVersions:     r.cfg.Retention.HistoryMaxVersions,
		TrashCutoffMs:   now.Add(-time.Duration(r.cfg.Retention.TrashDays) * day).UnixMilli(),
	})
	if err != nil {
		return fmt.Errorf("prune: %w", err)
	}
	collected, err := r.collectChunks(ctx, now.Add(-r.cfg.GCGrace).UnixMilli())
	if err != nil {
		return fmt.Errorf("collect chunks: %w", err)
	}
	r.log.Info("maintenance done",
		"versions_pruned", stats.VersionsDeleted, "files_purged", stats.FilesPurged, "chunks_deleted", collected)
	return nil
}

func (r *Runner) collectChunks(ctx context.Context, cutoffMs int64) (int, error) {
	deleted := 0
	for i := 0; i < maxGCBatches; i++ {
		dead, err := r.st.DeadChunks(ctx, cutoffMs, gcBatch)
		if err != nil {
			return deleted, err
		}
		for _, c := range dead {
			ok, err := r.st.DeleteDeadChunk(ctx, c, cutoffMs)
			if err != nil {
				return deleted, err
			}
			if !ok {
				continue
			}
			deleted++
			if err := r.blobs.Delete(ctx, c.BlobKey); err != nil {
				// The row is gone, so nothing can reach this blob; it is only wasted space.
				r.log.Warn("delete chunk blob", "blob_key", c.BlobKey, "err", err)
			}
		}
		if len(dead) < gcBatch {
			break
		}
	}
	return deleted, nil
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd server && go test -race ./internal/store/... ./internal/jobs/`
Expected: `ok` for both.

- [ ] **Step 6: Commit**

```bash
git add server/internal/store server/internal/jobs
git commit -m "feat(jobs): lease-guarded history retention, trash purge and chunk GC

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 16: Admin CLI, wiring, `obsync` binary and end-to-end test

**Files:**
- Create: `server/internal/admin/admin.go`, `server/internal/admin/admin_test.go`
- Create: `server/internal/app/app.go`, `server/internal/app/app_test.go`
- Create: `server/cmd/obsync/main.go`, `server/cmd/obsync/main_test.go`

**Interfaces:**
- Consumes: everything above.
- Produces:
  ```go
  // package admin
  type Store interface { CreateUser; UserByUsername; ListUsers; SetPassword; DeleteUser } // store signatures, Tasks 4 and 6
  type Deps struct { Store Store; Blobs blob.Store; DefaultQuotaBytes int64; Params auth.Params; Stdin io.Reader; Stdout io.Writer }
  func Run(ctx context.Context, args []string, d Deps) error // args after "admin": user create|list|delete|set-password

  // package app
  type Options struct { PasswordParams auth.Params } // zero value = auth.DefaultParams
  type App struct { Store *store.Store; Blobs blob.Store; Handler http.Handler; Jobs *jobs.Runner }
  func Build(ctx context.Context, cfg config.Config, log *slog.Logger, opts Options) (*App, error) // opens + migrates the DB
  func (a *App) Serve(ctx context.Context, ln net.Listener) error // until ctx ends, then graceful shutdown
  func (a *App) Close() error
  ```
- CLI usage:
  - `obsync serve`
  - `obsync migrate`
  - `obsync admin user create --username NAME [--quota-bytes N]` (password read from stdin; on a terminal it prompts twice)
  - `obsync admin user list`
  - `obsync admin user delete --username NAME`
  - `obsync admin user set-password --username NAME`

  Every command accepts `--config PATH`, default `$OBSYNC_CONFIG`, placed before its arguments.

- [ ] **Step 1: Write the failing tests**

`server/internal/admin/admin_test.go`:
```go
package admin_test

import (
	"bytes"
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/jfms7s/obsidian-sync/server/internal/admin"
	"github.com/jfms7s/obsidian-sync/server/internal/auth"
	"github.com/jfms7s/obsidian-sync/server/internal/blob"
	"github.com/jfms7s/obsidian-sync/server/internal/store"
	"github.com/jfms7s/obsidian-sync/server/internal/store/storetest"
)

var ctx = context.Background()

func deps(t *testing.T, st *store.Store, blobs blob.Store, stdin string) (admin.Deps, *bytes.Buffer) {
	t.Helper()
	out := &bytes.Buffer{}
	return admin.Deps{Store: st, Blobs: blobs, DefaultQuotaBytes: 1 << 30, Params: auth.FastParams,
		Stdin: strings.NewReader(stdin), Stdout: out}, out
}

func TestUserCreateListSetPasswordDelete(t *testing.T) {
	st, _ := storetest.New(t)
	blobs, _ := blob.NewFS(t.TempDir())

	d, out := deps(t, st, blobs, "correct horse\n")
	if err := admin.Run(ctx, []string{"user", "create", "--username", "alice", "--quota-bytes", "5000"}, d); err != nil {
		t.Fatal(err)
	}
	u, err := st.UserByUsername(ctx, "alice")
	if err != nil || u.QuotaBytes != 5000 {
		t.Fatalf("user = %+v, err %v", u, err)
	}
	if ok, _ := auth.VerifyPassword("correct horse", u.PasswordHash); !ok {
		t.Fatal("password not set")
	}
	if !strings.Contains(out.String(), "created user alice") {
		t.Fatalf("output = %q", out)
	}

	d, _ = deps(t, st, blobs, "another one\n")
	if err := admin.Run(ctx, []string{"user", "create", "--username", "alice"}, d); err == nil {
		t.Fatal("duplicate user created")
	}

	d, out = deps(t, st, blobs, "")
	if err := admin.Run(ctx, []string{"user", "list"}, d); err != nil || !strings.Contains(out.String(), "alice") {
		t.Fatalf("list = %q, err %v", out, err)
	}

	d, _ = deps(t, st, blobs, "battery staple\n")
	if err := admin.Run(ctx, []string{"user", "set-password", "--username", "alice"}, d); err != nil {
		t.Fatal(err)
	}
	u, _ = st.UserByUsername(ctx, "alice")
	if ok, _ := auth.VerifyPassword("battery staple", u.PasswordHash); !ok {
		t.Fatal("password not changed")
	}

	vault := storetest.SeedVault(t, st, u.ID)
	key := "v/" + vault.ID
	_ = blobs.Put(ctx, key, strings.NewReader("cipher"))
	if _, err := st.InsertChunk(ctx, store.Chunk{VaultID: vault.ID, ChunkID: storetest.ChunkID(1), BlobKey: key, Size: 6}); err != nil {
		t.Fatal(err)
	}
	d, _ = deps(t, st, blobs, "")
	if err := admin.Run(ctx, []string{"user", "delete", "--username", "alice"}, d); err != nil {
		t.Fatal(err)
	}
	if _, err := st.UserByUsername(ctx, "alice"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("user still there: %v", err)
	}
	if _, err := blobs.Get(ctx, key); !errors.Is(err, blob.ErrNotFound) {
		t.Fatalf("blob still there: %v", err)
	}
}

func TestUserCreateValidation(t *testing.T) {
	st, _ := storetest.New(t)
	blobs, _ := blob.NewFS(t.TempDir())
	for name, tc := range map[string]struct {
		args  []string
		stdin string
	}{
		"short password": {[]string{"user", "create", "--username", "bob"}, "short\n"},
		"no username":    {[]string{"user", "create"}, "long enough\n"},
		"bad username":   {[]string{"user", "create", "--username", "bob smith"}, "long enough\n"},
		"unknown verb":   {[]string{"user", "frobnicate"}, ""},
		"no subcommand":  {nil, ""},
	} {
		d, _ := deps(t, st, blobs, tc.stdin)
		if err := admin.Run(ctx, tc.args, d); err == nil {
			t.Errorf("%s: expected an error", name)
		}
	}
}
```

`server/internal/app/app_test.go`:
```go
package app_test

import (
	"bytes"
	"context"
	"encoding/hex"
	"io"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"google.golang.org/protobuf/proto"

	"github.com/jfms7s/obsidian-sync/server/internal/admin"
	"github.com/jfms7s/obsidian-sync/server/internal/app"
	"github.com/jfms7s/obsidian-sync/server/internal/auth"
	"github.com/jfms7s/obsidian-sync/server/internal/config"
	obsyncv1 "github.com/jfms7s/obsidian-sync/server/internal/gen/obsync/v1"
	"github.com/jfms7s/obsidian-sync/server/internal/ids"
)

// TestEndToEnd drives a real server over TCP: an admin creates a user, a
// device logs in, sets up keys and a vault, uploads and commits a chunk,
// sees the WebSocket notification, pulls the change, and finally the server
// shuts down promptly while the WebSocket is still open.
func TestEndToEnd(t *testing.T) {
	dir := t.TempDir()
	cfg, err := config.Load("", func(k string) string {
		if k == "OBSYNC_DATA_DIR" {
			return dir
		}
		return ""
	})
	if err != nil {
		t.Fatal(err)
	}
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	a, err := app.Build(context.Background(), cfg, log, app.Options{PasswordParams: auth.FastParams})
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()

	err = admin.Run(context.Background(), []string{"user", "create", "--username", "alice"}, admin.Deps{
		Store: a.Store, Blobs: a.Blobs, DefaultQuotaBytes: cfg.DefaultQuotaBytes, Params: auth.FastParams,
		Stdin: strings.NewReader("correct horse\n"), Stdout: io.Discard,
	})
	if err != nil {
		t.Fatal(err)
	}

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	ctx, stop := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- a.Serve(ctx, ln) }()
	base := "http://" + ln.Addr().String()
	c := &client{t: t, base: base}

	var login obsyncv1.LoginResponse
	c.call("POST", "/v1/auth/login", &obsyncv1.LoginRequest{Username: "alice", Password: "correct horse", DeviceName: "e2e"}, &login, 200)
	c.token = login.Token

	c.call("PUT", "/v1/keys", &obsyncv1.KeyBundle{
		PublicEncKey: bytes.Repeat([]byte{1}, 32), PublicSignKey: bytes.Repeat([]byte{2}, 32),
		PassSalt: bytes.Repeat([]byte{3}, 16), PassParams: &obsyncv1.Argon2Params{MemoryKib: 19456, Iterations: 2, Parallelism: 1},
		PassWrapped: []byte("p"), RecoveryWrapped: []byte("r"),
	}, nil, 204)

	vaultID := ids.New()
	c.call("POST", "/v1/vaults", &obsyncv1.CreateVaultRequest{VaultId: vaultID, EncName: []byte("n"),
		Keys: []*obsyncv1.VaultKey{{Epoch: 0, SealedKey: []byte("a")}, {Epoch: 1, SealedKey: []byte("b")}}}, nil, 201)

	ws, _, err := websocket.Dial(context.Background(), "ws://"+ln.Addr().String()+"/v1/ws", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer ws.CloseNow()
	wsSend(t, ws, &obsyncv1.ClientFrame{Frame: &obsyncv1.ClientFrame_Auth{Auth: &obsyncv1.Auth{Token: c.token}}})
	if f := wsRecv(t, ws); f.GetAuthOk() == nil {
		t.Fatalf("auth reply = %v", f)
	}
	wsSend(t, ws, &obsyncv1.ClientFrame{Frame: &obsyncv1.ClientFrame_Subscribe{Subscribe: &obsyncv1.Subscribe{VaultIds: []string{vaultID}}}})
	if n := wsRecv(t, ws).GetNotify(); n.GetSeq() != 0 {
		t.Fatalf("initial notify = %v", n)
	}

	chunkID := bytes.Repeat([]byte{0xcd}, 32)
	c.raw("PUT", "/v1/vaults/"+vaultID+"/chunks/"+hex.EncodeToString(chunkID), []byte("ciphertext"), 204)
	var cr obsyncv1.CommitResponse
	c.call("POST", "/v1/vaults/"+vaultID+"/commit", &obsyncv1.CommitRequest{Commits: []*obsyncv1.Commit{{
		FileId: bytes.Repeat([]byte{1}, 32), VersionId: ids.Bytes(16), Epoch: 1, EncMeta: []byte("m"),
		ChunkIds: [][]byte{chunkID}, Size: 10,
	}}}, &cr, 200)
	if !cr.Results[0].Ok {
		t.Fatalf("commit = %v", cr.Results[0])
	}
	if n := wsRecv(t, ws).GetNotify(); n.GetSeq() != 1 {
		t.Fatalf("live notify = %v", n)
	}
	var changes obsyncv1.ChangesResponse
	c.call("GET", "/v1/vaults/"+vaultID+"/changes?since=0", nil, &changes, 200)
	if len(changes.Versions) != 1 {
		t.Fatalf("changes = %v", &changes)
	}
	c.raw("GET", "/healthz", nil, 200)
	c.raw("GET", "/readyz", nil, 200)

	stop()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("serve: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("server did not shut down while a WebSocket was open")
	}
}

type client struct {
	t     *testing.T
	base  string
	token string
}

func (c *client) call(method, path string, in, out proto.Message, wantStatus int) {
	c.t.Helper()
	var body []byte
	if in != nil {
		body, _ = proto.Marshal(in)
	}
	data := c.raw(method, path, body, wantStatus)
	if out != nil {
		if err := proto.Unmarshal(data, out); err != nil {
			c.t.Fatal(err)
		}
	}
}

func (c *client) raw(method, path string, body []byte, wantStatus int) []byte {
	c.t.Helper()
	req, _ := http.NewRequest(method, c.base+path, bytes.NewReader(body))
	if c.token != "" {
		req.Header.Set("Authorization", "Bearer "+c.token)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		c.t.Fatal(err)
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != wantStatus {
		c.t.Fatalf("%s %s = %d, want %d (%q)", method, path, resp.StatusCode, wantStatus, data)
	}
	return data
}

func wsSend(t *testing.T, c *websocket.Conn, f *obsyncv1.ClientFrame) {
	t.Helper()
	data, _ := proto.Marshal(f)
	if err := c.Write(context.Background(), websocket.MessageBinary, data); err != nil {
		t.Fatal(err)
	}
}

func wsRecv(t *testing.T, c *websocket.Conn) *obsyncv1.ServerFrame {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	_, data, err := c.Read(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var f obsyncv1.ServerFrame
	if err := proto.Unmarshal(data, &f); err != nil {
		t.Fatal(err)
	}
	return &f
}
```

`server/cmd/obsync/main_test.go`:
```go
package main

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRunWithoutCommandPrintsUsage(t *testing.T) {
	err := run(context.Background(), nil)
	if err == nil || !strings.Contains(err.Error(), "usage: obsync") {
		t.Fatalf("err = %v", err)
	}
}

func TestRunUnknownCommand(t *testing.T) {
	t.Setenv("OBSYNC_DATA_DIR", t.TempDir())
	if err := run(context.Background(), []string{"frobnicate"}); err == nil {
		t.Fatal("expected an error")
	}
}

func TestMigrateCreatesDatabase(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("OBSYNC_DATA_DIR", dir)
	if err := run(context.Background(), []string{"migrate"}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, "meta.db")); err != nil {
		t.Fatalf("database not created: %v", err)
	}
}

func TestInvalidConfigIsReported(t *testing.T) {
	t.Setenv("OBSYNC_DATA_DIR", t.TempDir())
	t.Setenv("OBSYNC_CLUSTER", "true")
	err := run(context.Background(), []string{"migrate"})
	if err == nil || !strings.Contains(err.Error(), "cluster mode is not available yet") {
		t.Fatalf("err = %v", err)
	}
}
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd server && go test ./internal/admin/ ./internal/app/ ./cmd/...`
Expected: FAIL because the packages don't exist.

- [ ] **Step 3: Implement `admin`**

`server/internal/admin/admin.go`:
```go
// Package admin implements `obsync admin`, the operator's user management.
package admin

import (
	"bufio"
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"regexp"
	"strings"
	"text/tabwriter"

	"github.com/jfms7s/obsidian-sync/server/internal/auth"
	"github.com/jfms7s/obsidian-sync/server/internal/blob"
	"github.com/jfms7s/obsidian-sync/server/internal/ids"
	"github.com/jfms7s/obsidian-sync/server/internal/store"
)

const minPasswordLen = 8

var (
	errUsage      = errors.New("usage: obsync admin user create|list|delete|set-password [--username NAME] [--quota-bytes N]")
	validUsername = regexp.MustCompile(`^[A-Za-z0-9._@-]{1,64}$`)
)

type Store interface {
	CreateUser(ctx context.Context, u store.User) error
	UserByUsername(ctx context.Context, username string) (store.User, error)
	ListUsers(ctx context.Context) ([]store.User, error)
	SetPassword(ctx context.Context, userID, hash string) error
	DeleteUser(ctx context.Context, userID string) ([]string, error)
}

type Deps struct {
	Store             Store
	Blobs             blob.Store
	DefaultQuotaBytes int64
	Params            auth.Params
	Stdin             io.Reader // the password, one line
	Stdout            io.Writer
}

func Run(ctx context.Context, args []string, d Deps) error {
	if len(args) < 2 || args[0] != "user" {
		return errUsage
	}
	switch args[1] {
	case "create":
		return userCreate(ctx, args[2:], d)
	case "list":
		return userList(ctx, d)
	case "delete":
		return userDelete(ctx, args[2:], d)
	case "set-password":
		return userSetPassword(ctx, args[2:], d)
	}
	return errUsage
}

func userCreate(ctx context.Context, args []string, d Deps) error {
	fs := flag.NewFlagSet("user create", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	username := fs.String("username", "", "")
	quota := fs.Int64("quota-bytes", d.DefaultQuotaBytes, "")
	if err := fs.Parse(args); err != nil {
		return errUsage
	}
	name, err := checkUsername(*username)
	if err != nil {
		return err
	}
	if *quota <= 0 {
		return errors.New("--quota-bytes must be positive")
	}
	hash, err := readAndHash(d)
	if err != nil {
		return err
	}
	err = d.Store.CreateUser(ctx, store.User{ID: ids.New(), Username: name, PasswordHash: hash, QuotaBytes: *quota})
	if errors.Is(err, store.ErrExists) {
		return fmt.Errorf("user %q already exists", name)
	}
	if err != nil {
		return err
	}
	fmt.Fprintf(d.Stdout, "created user %s\n", name)
	return nil
}

func userList(ctx context.Context, d Deps) error {
	users, err := d.Store.ListUsers(ctx)
	if err != nil {
		return err
	}
	tw := tabwriter.NewWriter(d.Stdout, 0, 4, 2, ' ', 0)
	fmt.Fprintln(tw, "USERNAME\tID\tQUOTA_BYTES")
	for _, u := range users {
		fmt.Fprintf(tw, "%s\t%s\t%d\n", u.Username, u.ID, u.QuotaBytes)
	}
	return tw.Flush()
}

func userDelete(ctx context.Context, args []string, d Deps) error {
	u, err := lookup(ctx, args, "user delete", d)
	if err != nil {
		return err
	}
	keys, err := d.Store.DeleteUser(ctx, u.ID)
	if err != nil {
		return err
	}
	failed := 0
	for _, k := range keys {
		if err := d.Blobs.Delete(ctx, k); err != nil {
			failed++
		}
	}
	fmt.Fprintf(d.Stdout, "deleted user %s (%d blobs removed", u.Username, len(keys)-failed)
	if failed > 0 {
		fmt.Fprintf(d.Stdout, ", %d could not be removed and are now orphaned", failed)
	}
	fmt.Fprintln(d.Stdout, ")")
	return nil
}

func userSetPassword(ctx context.Context, args []string, d Deps) error {
	u, err := lookup(ctx, args, "user set-password", d)
	if err != nil {
		return err
	}
	hash, err := readAndHash(d)
	if err != nil {
		return err
	}
	if err := d.Store.SetPassword(ctx, u.ID, hash); err != nil {
		return err
	}
	fmt.Fprintf(d.Stdout, "password changed for %s (existing devices stay signed in; revoke them from a device if needed)\n", u.Username)
	return nil
}

func lookup(ctx context.Context, args []string, name string, d Deps) (store.User, error) {
	fs := flag.NewFlagSet(name, flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	username := fs.String("username", "", "")
	if err := fs.Parse(args); err != nil {
		return store.User{}, errUsage
	}
	if *username == "" {
		return store.User{}, errors.New("--username is required")
	}
	u, err := d.Store.UserByUsername(ctx, *username)
	if errors.Is(err, store.ErrNotFound) {
		return store.User{}, fmt.Errorf("no user named %q", *username)
	}
	return u, err
}

func checkUsername(s string) (string, error) {
	name := strings.TrimSpace(s)
	if name == "" {
		return "", errors.New("--username is required")
	}
	if !validUsername.MatchString(name) {
		return "", errors.New("usernames are 1-64 characters of letters, digits and . _ @ -")
	}
	return name, nil
}

func readAndHash(d Deps) (string, error) {
	line, err := bufio.NewReader(d.Stdin).ReadString('\n')
	if err != nil && !errors.Is(err, io.EOF) {
		return "", fmt.Errorf("read password: %w", err)
	}
	password := strings.TrimRight(line, "\r\n")
	if len(password) < minPasswordLen {
		return "", fmt.Errorf("the password must be at least %d characters", minPasswordLen)
	}
	return auth.HashPassword(password, d.Params)
}
```

- [ ] **Step 4: Implement `app`**

`server/internal/app/app.go`:
```go
// Package app wires obsync's components together and runs the server.
package app

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"time"

	"github.com/jfms7s/obsidian-sync/server/internal/api"
	"github.com/jfms7s/obsidian-sync/server/internal/auth"
	"github.com/jfms7s/obsidian-sync/server/internal/blob"
	"github.com/jfms7s/obsidian-sync/server/internal/bus"
	"github.com/jfms7s/obsidian-sync/server/internal/config"
	"github.com/jfms7s/obsidian-sync/server/internal/hub"
	"github.com/jfms7s/obsidian-sync/server/internal/jobs"
	"github.com/jfms7s/obsidian-sync/server/internal/store"
	"github.com/jfms7s/obsidian-sync/server/internal/syncsvc"
)

const shutdownTimeout = 30 * time.Second

type Options struct {
	PasswordParams auth.Params // zero = auth.DefaultParams
}

type App struct {
	Store   *store.Store
	Blobs   blob.Store
	Handler http.Handler
	Jobs    *jobs.Runner
}

// Build opens and migrates the database and assembles the single-node server.
func Build(ctx context.Context, cfg config.Config, log *slog.Logger, opts Options) (*App, error) {
	if opts.PasswordParams == (auth.Params{}) {
		opts.PasswordParams = auth.DefaultParams
	}
	st, err := store.Open(ctx, store.Options{URL: cfg.DatabaseURL, AuthToken: cfg.DatabaseAuthToken})
	if err != nil {
		return nil, err
	}
	if err := st.Migrate(ctx); err != nil {
		st.Close()
		return nil, fmt.Errorf("migrate database: %w", err)
	}
	blobs, err := blob.NewFS(cfg.BlobFSDir)
	if err != nil {
		st.Close()
		return nil, err
	}
	authSvc, err := auth.NewService(st, auth.Options{Params: opts.PasswordParams})
	if err != nil {
		st.Close()
		return nil, err
	}
	b := bus.NewMemory()
	syncSvc := syncsvc.New(st, blobs, b, syncsvc.Limits{MaxFileSizeBytes: cfg.MaxFileSizeBytes}, log)
	handler := api.NewHandler(api.Deps{
		Auth:  authSvc,
		Sync:  syncSvc,
		Store: st,
		Hub:   hub.New(authSvc, st, b, log, hub.Options{}),
		Ready: func(ctx context.Context) error { return errors.Join(st.Ping(ctx), blobs.Ping(ctx)) },
		Log:   log,
	})
	runner := jobs.New(st, blobs, jobs.Config{
		Interval:  cfg.JobsInterval(),
		Retention: cfg.Retention,
		GCGrace:   cfg.GCGrace(),
	}, time.Now, log)
	return &App{Store: st, Blobs: blobs, Handler: handler, Jobs: runner}, nil
}

func (a *App) Close() error { return a.Store.Close() }

// Serve runs HTTP on ln and the maintenance jobs until ctx ends, then shuts
// down gracefully.
func (a *App) Serve(ctx context.Context, ln net.Listener) error {
	baseCtx, cancelBase := context.WithCancel(context.Background())
	defer cancelBase()
	srv := &http.Server{
		Handler:           a.Handler,
		ReadHeaderTimeout: 10 * time.Second,
		BaseContext:       func(net.Listener) context.Context { return baseCtx },
	}
	// Shutdown does not wait for hijacked WebSocket connections; cancelling
	// their request context makes the hub close them.
	srv.RegisterOnShutdown(cancelBase)

	jobsCtx, stopJobs := context.WithCancel(ctx)
	defer stopJobs()
	go a.Jobs.Run(jobsCtx)

	errCh := make(chan error, 1)
	go func() { errCh <- srv.Serve(ln) }()
	select {
	case err := <-errCh:
		return err
	case <-ctx.Done():
	}
	shutdownCtx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		return fmt.Errorf("shutdown: %w", err)
	}
	return nil
}
```

- [ ] **Step 5: Implement the binary**

Run: `cd server && go get golang.org/x/term@v0.27.0`

`server/cmd/obsync/main.go`:
```go
// Command obsync is the end-to-end encrypted Obsidian sync server.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net"
	"os"
	"os/signal"
	"strings"
	"syscall"

	"golang.org/x/term"

	"github.com/jfms7s/obsidian-sync/server/internal/admin"
	"github.com/jfms7s/obsidian-sync/server/internal/app"
	"github.com/jfms7s/obsidian-sync/server/internal/auth"
	"github.com/jfms7s/obsidian-sync/server/internal/blob"
	"github.com/jfms7s/obsidian-sync/server/internal/config"
	"github.com/jfms7s/obsidian-sync/server/internal/store"
)

const usage = `usage: obsync <command> [--config PATH] [args]

commands:
  serve     run the sync server
  migrate   apply database migrations and exit
  admin     manage users: obsync admin user create|list|delete|set-password

--config defaults to $OBSYNC_CONFIG; OBSYNC_* environment variables override the file.`

func main() {
	if err := run(context.Background(), os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "obsync:", err)
		os.Exit(1)
	}
}

func run(ctx context.Context, args []string) error {
	if len(args) == 0 {
		return errors.New(usage)
	}
	cmd := args[0]
	fs := flag.NewFlagSet(cmd, flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	configPath := fs.String("config", os.Getenv("OBSYNC_CONFIG"), "")
	if err := fs.Parse(args[1:]); err != nil {
		return errors.New(usage)
	}
	cfg, err := config.Load(*configPath, os.Getenv)
	if err != nil {
		return fmt.Errorf("config: %w", err)
	}
	log := newLogger(cfg.LogLevel)

	switch cmd {
	case "serve":
		return serve(ctx, cfg, log)
	case "migrate":
		return migrate(ctx, cfg)
	case "admin":
		return adminCmd(ctx, cfg, fs.Args())
	}
	return errors.New(usage)
}

func newLogger(level string) *slog.Logger {
	var l slog.Level
	_ = l.UnmarshalText([]byte(level)) // config.Validate already checked it
	return slog.New(slog.NewJSONHandler(os.Stderr, &slog.HandlerOptions{Level: l}))
}

func serve(ctx context.Context, cfg config.Config, log *slog.Logger) error {
	ctx, stop := signal.NotifyContext(ctx, os.Interrupt, syscall.SIGTERM)
	defer stop()
	a, err := app.Build(ctx, cfg, log, app.Options{})
	if err != nil {
		return err
	}
	defer a.Close()
	ln, err := net.Listen("tcp", cfg.Listen)
	if err != nil {
		return fmt.Errorf("listen: %w", err)
	}
	// Never log the database URL: it may carry credentials.
	log.Info("obsync listening", "addr", ln.Addr().String(), "data_dir", cfg.DataDir)
	return a.Serve(ctx, ln)
}

func migrate(ctx context.Context, cfg config.Config) error {
	st, err := store.Open(ctx, store.Options{URL: cfg.DatabaseURL, AuthToken: cfg.DatabaseAuthToken})
	if err != nil {
		return err
	}
	defer st.Close()
	if err := st.Migrate(ctx); err != nil {
		return err
	}
	fmt.Println("migrations applied")
	return nil
}

func adminCmd(ctx context.Context, cfg config.Config, args []string) error {
	st, err := store.Open(ctx, store.Options{URL: cfg.DatabaseURL, AuthToken: cfg.DatabaseAuthToken})
	if err != nil {
		return err
	}
	defer st.Close()
	if err := st.Migrate(ctx); err != nil {
		return err
	}
	blobs, err := blob.NewFS(cfg.BlobFSDir)
	if err != nil {
		return err
	}
	stdin, err := passwordInput(args)
	if err != nil {
		return err
	}
	return admin.Run(ctx, args, admin.Deps{
		Store: st, Blobs: blobs, DefaultQuotaBytes: cfg.DefaultQuotaBytes, Params: auth.DefaultParams,
		Stdin: stdin, Stdout: os.Stdout,
	})
}

// passwordInput prompts twice without echo when stdin is a terminal and the
// command needs a password; otherwise the password is read from stdin.
func passwordInput(args []string) (io.Reader, error) {
	needs := len(args) >= 2 && (args[1] == "create" || args[1] == "set-password")
	fd := int(os.Stdin.Fd())
	if !needs || !term.IsTerminal(fd) {
		return os.Stdin, nil
	}
	fmt.Fprint(os.Stderr, "Password: ")
	first, err := term.ReadPassword(fd)
	fmt.Fprintln(os.Stderr)
	if err != nil {
		return nil, err
	}
	fmt.Fprint(os.Stderr, "Repeat password: ")
	second, err := term.ReadPassword(fd)
	fmt.Fprintln(os.Stderr)
	if err != nil {
		return nil, err
	}
	if string(first) != string(second) {
		return nil, errors.New("passwords do not match")
	}
	return strings.NewReader(string(first) + "\n"), nil
}
```

- [ ] **Step 6: Run the whole suite**

Run: `cd server && go mod tidy && go vet ./... && go test -race ./...`
Expected: `go vet` prints nothing, and every package reports `ok`.

- [ ] **Step 7: Smoke-test the real binary by hand**

Run:
```bash
cd server && go build -o obsync ./cmd/obsync && export OBSYNC_DATA_DIR=$(mktemp -d) OBSYNC_LISTEN=127.0.0.1:18080 \
  && printf 'correct horse\n' | ./obsync admin user create --username alice \
  && ./obsync admin user list \
  && (./obsync serve & echo $! > /tmp/obsync.pid; sleep 1; curl -fsS http://127.0.0.1:18080/readyz; echo; kill $(cat /tmp/obsync.pid))
```
Expected:
1. `created user alice`
2. a table with `alice`
3. `ok`
4. a JSON log line `obsync listening`
5. the server exits cleanly after `kill`

- [ ] **Step 8: Commit**

```bash
git add server
git commit -m "feat(server): obsync serve/migrate/admin commands with end-to-end test

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Spec coverage (sub-project 1, server side)

| Spec requirement | Where |
|---|---|
| §5.1 file identity: server enforces one row per `(vault_id, file_id)`; renames are delete + create reusing chunks | Task 7 (`files` PK, commit rules); chunk reuse works because chunks are per vault, not per file (Tasks 6–7) |
| §5.2 versions, 4 MiB chunks, server sees only ids/sizes | Tasks 3, 6, 7, 11 (`ChunkSize`, `MaxChunkCipherBytes`) |
| §5.3 push: exists-check, PUT missing, commit with `base_version`, per-commit results, notify | Tasks 6, 7, 11, 13 |
| §5.4 pull: Notify → paged Changes in seq order | Tasks 7, 11, 13, 14 |
| §5.6 reconcile: paged Heads | Tasks 7, 11, 13 |
| §5.7 history, trash, retention, mark-and-sweep GC with grace, job leases | Tasks 7, 15 |
| §6.2 key bundle storage, public keys immutable | Tasks 4, 12 |
| §6.3 sealed naming key (epoch 0) + epoch keys per member | Tasks 5, 13 |
| §6.3 `STALE_EPOCH` | Task 7 |
| §6.6 device tokens (SHA-256 at rest), list, revoke, `DEVICE_REVOKED` | Tasks 4, 10, 12, 14 |
| §7.1 config: env + YAML, fail fast on invalid combinations | Task 2 |
| §7.2 single node: local libSQL, `/data/blobs`, in-memory bus, migrate on start | Tasks 3, 8, 9, 16 |
| §7.4 per-user quota (shared vaults charge the owner), max file size | Tasks 5, 6, 11 |
| §7.4 rate limiting (login only; per-device limits in sub-project 5) | Task 10 |
| §7.5 typed error codes | Tasks 1, 10, 12 |
| §7.6 `/healthz`, `/readyz`, JSON `slog`, nothing secret logged | Tasks 12, 16 |
| §8 hermetic libSQL tests, contract suites, concurrency tests | Tasks 3, 7, 8, 9 |
| §9.1 `obsync serve`, `migrate`, `admin user create\|list\|delete\|set-password` | Task 16 |

Not in this plan, by design:
- Prometheus metrics, clustering, S3, NATS: sub-project 5.
- Everything client-side, including the convergence suite: plan 2.
- Docker, compose, release binaries, CI: plan 3.
