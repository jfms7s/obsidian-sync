// Package storetest gives tests in any package a migrated store in a
// temporary directory and a clock they control.
package storetest

import (
	"bytes"
	"context"
	"encoding/hex"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/jfms7s/obsidian-sync/server/internal/ids"
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
