package jobs_test

import (
	"bytes"
	"context"
	"encoding/hex"
	"errors"
	"io"
	"log/slog"
	"testing"
	"time"

	"github.com/jfms7s/obsidian-sync/server/internal/blob"
	"github.com/jfms7s/obsidian-sync/server/internal/config"
	"github.com/jfms7s/obsidian-sync/server/internal/jobs"
	"github.com/jfms7s/obsidian-sync/server/internal/store"
	"github.com/jfms7s/obsidian-sync/server/internal/store/storetest"
)

func TestRunOnceDeletesUnreferencedChunkBlobs(t *testing.T) {
	ctx := context.Background()
	st, clk := storetest.New(t)
	blobs, err := blob.NewFS(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	user := storetest.SeedUser(t, st, "alice")
	vault := storetest.SeedVault(t, st, user.ID)

	putChunk := func(b byte) string {
		key := "test/" + hex.EncodeToString(storetest.ChunkID(b))
		if err := blobs.Put(ctx, key, bytes.NewReader([]byte("cipher"))); err != nil {
			t.Fatal(err)
		}
		if _, err := st.InsertChunk(ctx, store.Chunk{VaultID: vault.ID, ChunkID: storetest.ChunkID(b), BlobKey: key, Size: 6}); err != nil {
			t.Fatal(err)
		}
		return key
	}
	oldKey, newKey := putChunk(1), putChunk(2)
	v1 := storetest.MustCommit(t, st, storetest.NewVersion(vault.ID, storetest.FileID(1), nil, storetest.ChunkID(1)))
	clk.Advance(31 * 24 * time.Hour)
	storetest.MustCommit(t, st, storetest.NewVersion(vault.ID, storetest.FileID(1), v1.VersionID, storetest.ChunkID(2)))

	r := jobs.New(st, blobs, jobs.Config{
		Interval:  time.Hour,
		Retention: config.Retention{HistoryDays: 30, TrashDays: 30},
		GCGrace:   24 * time.Hour,
	}, clk.Now, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err := r.RunOnce(ctx); err != nil {
		t.Fatal(err)
	}

	if _, err := blobs.Get(ctx, oldKey); !errors.Is(err, blob.ErrNotFound) {
		t.Fatalf("old chunk blob survived: %v", err)
	}
	rc, err := blobs.Get(ctx, newKey)
	if err != nil {
		t.Fatalf("live chunk blob deleted: %v", err)
	}
	rc.Close()
	if used, _ := st.UsageBytes(ctx, user.ID); used != 6 {
		t.Fatalf("usage = %d, want 6", used)
	}
}

func TestRunOnceSkipsWhenAnotherReplicaHoldsTheLease(t *testing.T) {
	ctx := context.Background()
	st, clk := storetest.New(t)
	if ok, _ := st.AcquireLease(ctx, "maintenance", "other-replica", time.Hour); !ok {
		t.Fatal("setup: lease not taken")
	}
	blobs, _ := blob.NewFS(t.TempDir())
	r := jobs.New(st, blobs, jobs.Config{Interval: time.Hour, GCGrace: time.Hour}, clk.Now, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err := r.RunOnce(ctx); err != nil {
		t.Fatalf("RunOnce without the lease must be a quiet no-op: %v", err)
	}
}
