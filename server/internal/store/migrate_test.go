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
