package jobs_test

import (
	"bytes"
	"context"
	"encoding/hex"
	"errors"
	"io"
	"log/slog"
	"sync"
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
	storetest.MustCommit(t, st, storetest.NewVersion(vault.ID, storetest.FileID(1), v1.VersionID, storetest.ChunkID(2)))
	clk.Advance(31 * 24 * time.Hour) // v1 was replaced 31 days ago

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

func discard() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

func TestRunOnceZeroHistoryDaysMeansNoAgeLimit(t *testing.T) {
	ctx := context.Background()
	st, clk := storetest.New(t)
	user := storetest.SeedUser(t, st, "alice")
	vault := storetest.SeedVault(t, st, user.ID)
	v1 := storetest.MustCommit(t, st, storetest.NewVersion(vault.ID, storetest.FileID(1), nil))
	storetest.MustCommit(t, st, storetest.NewVersion(vault.ID, storetest.FileID(1), v1.VersionID))
	clk.Advance(1000 * 24 * time.Hour)

	blobs, _ := blob.NewFS(t.TempDir())
	r := jobs.New(st, blobs, jobs.Config{
		Interval:  time.Hour,
		Retention: config.Retention{HistoryDays: 0, HistoryMaxVersions: 0, TrashDays: 30},
		GCGrace:   time.Hour,
	}, clk.Now, discard())
	if err := r.RunOnce(ctx); err != nil {
		t.Fatal(err)
	}
	if hist, _ := st.History(ctx, vault.ID, storetest.FileID(1)); len(hist) != 2 {
		t.Fatalf("history = %d versions, want both kept", len(hist))
	}
}

func TestRunWithoutIntervalUsesDefault(t *testing.T) {
	st, clk := storetest.New(t)
	blobs, _ := blob.NewFS(t.TempDir())
	r := jobs.New(st, blobs, jobs.Config{Retention: config.Retention{TrashDays: 30}, GCGrace: time.Hour}, clk.Now, discard())
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	r.Run(ctx) // must return instead of panicking on a zero ticker interval
}

// signalStore reports when the runner reaches Prune, i.e. holds the lease.
type signalStore struct {
	*store.Store
	once    sync.Once
	pruning chan struct{}
}

func (s *signalStore) Prune(ctx context.Context, p store.PrunePolicy) (store.PruneStats, error) {
	s.once.Do(func() { close(s.pruning) })
	return s.Store.Prune(ctx, p)
}

// A runner that stops gives its lease back, so a restarted process does not
// wait two intervals for maintenance.
func TestRunReleasesLeaseOnExit(t *testing.T) {
	st, clk := storetest.New(t)
	sig := &signalStore{Store: st, pruning: make(chan struct{})}
	blobs, _ := blob.NewFS(t.TempDir())
	r := jobs.New(sig, blobs, jobs.Config{Interval: time.Hour, Retention: config.Retention{TrashDays: 30}, GCGrace: time.Hour},
		clk.Now, discard())
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { defer close(done); r.Run(ctx) }()

	select {
	case <-sig.pruning:
	case <-time.After(5 * time.Second):
		t.Fatal("runner never took the lease")
	}
	cancel()
	<-done
	if ok, _ := st.AcquireLease(context.Background(), "maintenance", "other", time.Hour); !ok {
		t.Fatal("lease still held after the runner stopped")
	}
}
