// Package storetest gives tests in any package a migrated store in a
// temporary directory and a clock they control.
package storetest

import (
	"context"
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
