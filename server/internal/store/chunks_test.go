package store_test

import (
	"encoding/hex"
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

func hexOf(b []byte) string { return hex.EncodeToString(b) }
