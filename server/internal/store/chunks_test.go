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
	if key, size, _ := st.ChunkBlob(ctx, v.ID, storetest.ChunkID(1)); key != "k1" || size != 100 {
		t.Fatalf("blob key = %q size %d, want the first upload's", key, size)
	}
	if used, _ := st.UsageBytes(ctx, u.ID); used != 100 {
		t.Fatalf("usage = %d, want 100 (counted once)", used)
	}

	exists, err := st.TouchChunks(ctx, v.ID, [][]byte{storetest.ChunkID(1), storetest.ChunkID(2)})
	if err != nil || !exists[0] || exists[1] {
		t.Fatalf("exists = %v, err %v", exists, err)
	}
	if _, _, err := st.ChunkBlob(ctx, v.ID, storetest.ChunkID(2)); !errors.Is(err, store.ErrNotFound) {
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

func TestInsertChunkEnforcesOwnerQuota(t *testing.T) {
	st, _ := storetest.New(t)
	small := store.User{ID: "0123456789abcdef0123456789abcdef", Username: "small", PasswordHash: "x", QuotaBytes: 8}
	if err := st.CreateUser(ctx, small); err != nil {
		t.Fatal(err)
	}
	v1 := storetest.SeedVault(t, st, small.ID)
	v2 := storetest.SeedVault(t, st, small.ID)

	if ok, err := st.InsertChunk(ctx, store.Chunk{VaultID: v1.ID, ChunkID: storetest.ChunkID(1), BlobKey: "k1", Size: 5}); err != nil || !ok {
		t.Fatalf("first insert ok=%v err=%v", ok, err)
	}
	// Usage counts every vault the owner has.
	_, err := st.InsertChunk(ctx, store.Chunk{VaultID: v2.ID, ChunkID: storetest.ChunkID(2), BlobKey: "k2", Size: 5})
	if !errors.Is(err, store.ErrQuotaExceeded) {
		t.Fatalf("over-quota insert err = %v, want ErrQuotaExceeded", err)
	}
	if _, _, err := st.ChunkBlob(ctx, v2.ID, storetest.ChunkID(2)); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("over-quota chunk was recorded: %v", err)
	}
	if used, _ := st.UsageBytes(ctx, small.ID); used != 5 {
		t.Fatalf("usage = %d, want 5", used)
	}
	// Exactly filling the quota is allowed.
	if ok, err := st.InsertChunk(ctx, store.Chunk{VaultID: v2.ID, ChunkID: storetest.ChunkID(3), BlobKey: "k3", Size: 3}); err != nil || !ok {
		t.Fatalf("filling insert ok=%v err=%v", ok, err)
	}
	// A chunk the vault already has costs nothing, even at the quota.
	if ok, err := st.InsertChunk(ctx, store.Chunk{VaultID: v1.ID, ChunkID: storetest.ChunkID(1), BlobKey: "k4", Size: 5}); err != nil || ok {
		t.Fatalf("duplicate insert ok=%v err=%v, want false, nil", ok, err)
	}
	if used, _ := st.UsageBytes(ctx, small.ID); used != 8 {
		t.Fatalf("usage = %d, want 8", used)
	}
}

func TestInsertChunkUnknownVault(t *testing.T) {
	st, _ := storetest.New(t)
	_, err := st.InsertChunk(ctx, store.Chunk{VaultID: "0123456789abcdef0123456789abcdef", ChunkID: storetest.ChunkID(1), BlobKey: "k", Size: 1})
	if !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("err = %v, want ErrNotFound", err)
	}
}

// Re-uploading a chunk that already exists restarts its garbage-collection
// grace period, just like an existence check does.
func TestInsertExistingChunkRefreshesTouchedAt(t *testing.T) {
	st, clk := storetest.New(t)
	u := storetest.SeedUser(t, st, "alice")
	v := storetest.SeedVault(t, st, u.ID)
	c := store.Chunk{VaultID: v.ID, ChunkID: storetest.ChunkID(1), BlobKey: "k1", Size: 100}
	if _, err := st.InsertChunk(ctx, c); err != nil {
		t.Fatal(err)
	}
	clk.Advance(time.Hour)
	c.BlobKey = "k2"
	if inserted, err := st.InsertChunk(ctx, c); err != nil || inserted {
		t.Fatalf("inserted=%v err=%v", inserted, err)
	}
	if dead, _ := st.DeadChunks(ctx, clk.Now().UnixMilli(), 10); len(dead) != 0 {
		t.Fatalf("re-uploaded chunk reported dead: %+v", dead)
	}
}
