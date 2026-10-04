package store_test

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"
	"time"

	"github.com/jfms7s/obsidian-sync/server/internal/ids"
	"github.com/jfms7s/obsidian-sync/server/internal/store"
)

// A second process (obsync admin while obsync serve runs) must wait for the
// other's write lock instead of failing with "database is locked".
func TestOpenWaitsForAnotherWriter(t *testing.T) {
	ctx := context.Background()
	url := "file:" + filepath.Join(t.TempDir(), "meta.db")
	st, err := store.Open(ctx, store.Options{URL: url})
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	if err := st.Migrate(ctx); err != nil {
		t.Fatal(err)
	}

	other, err := sql.Open("libsql", url)
	if err != nil {
		t.Fatal(err)
	}
	defer other.Close()
	other.SetMaxOpenConns(1)
	tx, err := other.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO job_leases (name, holder, expires_at) VALUES ('x', 'y', 0)`); err != nil {
		t.Fatal(err)
	}
	released := make(chan error, 1)
	go func() {
		time.Sleep(300 * time.Millisecond)
		released <- tx.Commit()
	}()

	u := store.User{ID: ids.New(), Username: "alice", PasswordHash: "x", QuotaBytes: 1}
	if err := st.CreateUser(ctx, u); err != nil {
		t.Fatalf("write while another connection holds the lock: %v", err)
	}
	if err := <-released; err != nil {
		t.Fatal(err)
	}
}
