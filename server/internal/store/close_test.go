package store_test

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/jfms7s/obsidian-sync/server/internal/ids"
	"github.com/jfms7s/obsidian-sync/server/internal/store"
	"github.com/jfms7s/obsidian-sync/server/internal/store/storetest"
)

// workload runs the store paths the app uses: users, devices, vaults, chunks,
// commits, changes, heads, history, trash and the jobs' queries.
func workload(t *testing.T, st *store.Store, name string) {
	t.Helper()
	u := storetest.SeedUser(t, st, name)
	if _, err := st.ListUsers(ctx); err != nil {
		t.Fatal(err)
	}
	d := store.Device{ID: ids.New(), UserID: u.ID, Name: "laptop"}
	if err := st.CreateDevice(ctx, d, []byte(name+"-token")); err != nil {
		t.Fatal(err)
	}
	if _, err := st.DeviceByTokenHash(ctx, []byte(name+"-token")); err != nil {
		t.Fatal(err)
	}
	if _, err := st.ListDevices(ctx, u.ID); err != nil {
		t.Fatal(err)
	}
	v := storetest.SeedVault(t, st, u.ID)
	if _, err := st.ListVaults(ctx, u.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := st.VaultKeys(ctx, v.ID, u.ID); err != nil {
		t.Fatal(err)
	}
	storetest.SeedChunk(t, st, v.ID, storetest.ChunkID(1), 10)
	storetest.SeedChunk(t, st, v.ID, storetest.ChunkID(2), 10)
	if _, err := st.TouchChunks(ctx, v.ID, [][]byte{storetest.ChunkID(1), storetest.ChunkID(9)}); err != nil {
		t.Fatal(err)
	}
	v1 := storetest.MustCommit(t, st, storetest.NewVersion(v.ID, storetest.FileID(1), nil, storetest.ChunkID(1)))
	storetest.MustCommit(t, st, storetest.NewVersion(v.ID, storetest.FileID(1), v1.VersionID, storetest.ChunkID(2)))
	// A conflict reads the head back inside the transaction.
	if _, err := st.Commit(ctx, storetest.NewVersion(v.ID, storetest.FileID(1), nil, storetest.ChunkID(1))); err != nil {
		t.Fatal(err)
	}
	if _, err := st.Changes(ctx, v.ID, 0, 10); err != nil {
		t.Fatal(err)
	}
	if _, err := st.Heads(ctx, v.ID, nil, 10); err != nil {
		t.Fatal(err)
	}
	if _, err := st.History(ctx, v.ID, storetest.FileID(1)); err != nil {
		t.Fatal(err)
	}
	if _, err := st.Trash(ctx, v.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := st.UsageBytes(ctx, u.ID); err != nil {
		t.Fatal(err)
	}
	if _, _, err := st.ChunkBlob(ctx, v.ID, storetest.ChunkID(1)); err != nil {
		t.Fatal(err)
	}
	// Lookups that miss must release their connection too.
	if _, err := st.UserByUsername(ctx, "nobody"); err == nil {
		t.Fatal("found a user that does not exist")
	}
	if _, err := st.VaultKeys(ctx, v.ID, "nobody"); err == nil {
		t.Fatal("non-member read vault keys")
	}
}

// Reopening a file right after Close in the same process must not fail with
// "database is locked": Close has to release every connection and the native
// database handle.
func TestReopenAfterCloseCanWrite(t *testing.T) {
	url := "file:" + filepath.Join(t.TempDir(), "meta.db")
	for i, name := range []string{"alice", "bob", "carol"} {
		st, err := store.Open(ctx, store.Options{URL: url})
		if err != nil {
			t.Fatalf("open #%d: %v", i, err)
		}
		if err := st.Migrate(ctx); err != nil {
			t.Fatalf("migrate #%d: %v", i, err)
		}
		workload(t, st, name)
		if s := store.DBStats(st); s.InUse != 0 {
			t.Fatalf("open #%d: %d connections still in use after the workload", i, s.InUse)
		}
		if err := st.Close(); err != nil {
			t.Fatalf("close #%d: %v", i, err)
		}
	}
	st, err := store.Open(context.Background(), store.Options{URL: url})
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	users, err := st.ListUsers(ctx)
	if err != nil || len(users) != 3 {
		t.Fatalf("users = %d, err %v", len(users), err)
	}
}
