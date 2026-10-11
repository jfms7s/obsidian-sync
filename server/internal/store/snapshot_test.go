package store_test

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/jfms7s/obsidian-sync/server/internal/store"
	"github.com/jfms7s/obsidian-sync/server/internal/store/storetest"
)

func openFile(t *testing.T, path string) *store.Store {
	t.Helper()
	st, err := store.Open(ctx, store.Options{URL: "file:" + path})
	if err != nil {
		t.Fatalf("open %s: %v", path, err)
	}
	t.Cleanup(func() { _ = st.Close() })
	return st
}

func TestSnapshotCopiesTheDatabase(t *testing.T) {
	st, _ := storetest.New(t)
	alice := storetest.SeedUser(t, st, "alice")
	storetest.SeedUser(t, st, "bob")
	v := storetest.SeedVault(t, st, alice.ID)
	storetest.SeedChunk(t, st, v.ID, storetest.ChunkID(1), 10)
	storetest.SeedChunk(t, st, v.ID, storetest.ChunkID(2), 20)
	storetest.SeedChunk(t, st, v.ID, storetest.ChunkID(3), 5) // uploaded, never committed
	storetest.MustCommit(t, st, storetest.NewVersion(v.ID, storetest.FileID(1), nil, storetest.ChunkID(1), storetest.ChunkID(2)))

	// A path with a quote must not break the statement.
	dst := filepath.Join(t.TempDir(), "it's here", "meta.db")
	if err := os.MkdirAll(filepath.Dir(dst), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := st.Snapshot(ctx, dst); err != nil {
		t.Fatal(err)
	}
	// The live store keeps working after the snapshot.
	storetest.SeedChunk(t, st, v.ID, storetest.ChunkID(4), 1)

	snap := openFile(t, dst)
	users, err := snap.ListUsers(ctx)
	if err != nil || len(users) != 2 {
		t.Fatalf("users = %+v, err %v", users, err)
	}
	refs, err := snap.ChunkRefs(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(refs) != 3 {
		t.Fatalf("chunk refs = %+v, want the three chunks of the snapshot", refs)
	}
	for _, r := range refs {
		if r.VaultID != v.ID || r.BlobKey == "" || r.Size == 0 {
			t.Fatalf("ref = %+v", r)
		}
		if bytes.Equal(r.ChunkID, storetest.ChunkID(4)) {
			t.Fatal("snapshot has a chunk inserted after it was taken")
		}
	}
	c, err := snap.ExportCounts(ctx)
	if err != nil {
		t.Fatal(err)
	}
	want := store.ExportCounts{SchemaVersion: c.SchemaVersion, Users: 2, Vaults: 1, Versions: 1, Chunks: 3, ChunkBytes: 35}
	if c != want || c.SchemaVersion < 1 {
		t.Fatalf("counts = %+v, want %+v", c, want)
	}
}

func TestSnapshotRefusesAnExistingFile(t *testing.T) {
	st, _ := storetest.New(t)
	dst := filepath.Join(t.TempDir(), "meta.db")
	if err := os.WriteFile(dst, []byte("keep me"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := st.Snapshot(ctx, dst); !errors.Is(err, store.ErrExists) {
		t.Fatalf("err = %v, want ErrExists", err)
	}
	if b, _ := os.ReadFile(dst); string(b) != "keep me" {
		t.Fatalf("existing file changed: %q", b)
	}
}
