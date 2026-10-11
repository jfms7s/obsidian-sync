package store_test

import (
	"context"
	"database/sql"
	"path/filepath"
	"strings"
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

	other, err := sql.Open(store.DriverName, url)
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

// synchronous is FULL unless the operator chose NORMAL: with FULL every
// committed transaction survives a power loss.
func TestOpenSetsSynchronous(t *testing.T) {
	ctx := context.Background()
	for _, tc := range []struct {
		mode store.Synchronous
		want int64 // PRAGMA synchronous: 1 NORMAL, 2 FULL
	}{
		{"", 2},
		{store.SynchronousFull, 2},
		{store.SynchronousNormal, 1},
	} {
		st, err := store.Open(ctx, store.Options{URL: "file:" + filepath.Join(t.TempDir(), "meta.db"), Synchronous: tc.mode})
		if err != nil {
			t.Fatalf("%q: %v", tc.mode, err)
		}
		got, err := store.PragmaInt(ctx, st, "synchronous")
		st.Close()
		if err != nil || got != tc.want {
			t.Errorf("%q: synchronous = %d, err %v; want %d", tc.mode, got, err, tc.want)
		}
	}
}

func TestOpenRejectsUnknownSynchronous(t *testing.T) {
	_, err := store.Open(context.Background(), store.Options{
		URL: "file:" + filepath.Join(t.TempDir(), "meta.db"), Synchronous: "off"})
	if err == nil || !strings.Contains(err.Error(), "synchronous") {
		t.Fatalf("err = %v, want a synchronous error", err)
	}
}

// The driver's bundled SQLite is named in the driver file (driver_*.go):
// bumping the driver changes it, so this test makes the bump visible.
func TestBundledSQLiteVersion(t *testing.T) {
	db, err := sql.Open(store.DriverName, "file:"+filepath.Join(t.TempDir(), "version.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var got string
	if err := db.QueryRowContext(context.Background(), `SELECT sqlite_version()`).Scan(&got); err != nil {
		t.Fatal(err)
	}
	if got != store.BundledSQLiteVersion {
		t.Fatalf("bundled SQLite is %s, the driver file names %s: check https://www.sqlite.org/cves.html for %s, then update bundledSQLiteVersion", got, store.BundledSQLiteVersion, got)
	}
}
