package store_test

import (
	"context"
	"path/filepath"
	"sync"
	"testing"

	"github.com/jfms7s/obsidian-sync/server/internal/store"
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

// Two processes (obsync migrate and a starting server, say) may migrate one
// fresh database at the same time; both must succeed.
func TestMigrateConcurrently(t *testing.T) {
	for i := 0; i < 5; i++ {
		url := "file:" + filepath.Join(t.TempDir(), "meta.db")
		stores := make([]*store.Store, 2)
		for j := range stores {
			st, err := store.Open(context.Background(), store.Options{URL: url})
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = st.Close() })
			stores[j] = st
		}
		errs := make([]error, len(stores))
		var wg sync.WaitGroup
		for j, st := range stores {
			wg.Add(1)
			go func() {
				defer wg.Done()
				errs[j] = st.Migrate(context.Background())
			}()
		}
		wg.Wait()
		for j, err := range errs {
			if err != nil {
				t.Fatalf("round %d: migrate %d: %v", i, j, err)
			}
		}
		if n := stores[0].AppliedMigrationsForTest(context.Background()); n != 1 {
			t.Fatalf("applied migrations = %d, want 1", n)
		}
	}
}
