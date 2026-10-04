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
