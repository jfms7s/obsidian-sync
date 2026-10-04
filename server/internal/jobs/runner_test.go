package jobs_test

import (
	"bytes"
	"context"
	"encoding/hex"
	"errors"
	"io"
	"log/slog"
	"strings"
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

var _ jobs.TempSweeper = (*blob.FS)(nil)

// recordingBlobs wraps a blob store, records Delete and SweepTemp calls in
// order, and implements jobs.TempSweeper with a canned result.
type recordingBlobs struct {
	blob.Store
	mu        sync.Mutex
	calls     []string
	olderThan time.Duration
	removed   int
	err       error
}

func (b *recordingBlobs) Delete(ctx context.Context, key string) error {
	b.mu.Lock()
	b.calls = append(b.calls, "delete")
	b.mu.Unlock()
	return b.Store.Delete(ctx, key)
}

func (b *recordingBlobs) SweepTemp(_ context.Context, olderThan time.Duration) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.calls = append(b.calls, "sweep")
	b.olderThan = olderThan
	return b.removed, b.err
}

// plainBlobs hides any methods beyond blob.Store, like a backend that has no
// temp files to sweep.
type plainBlobs struct{ blob.Store }

// seedDeadChunk stores a chunk blob and row that the next RunOnce collects.
func seedDeadChunk(t *testing.T, st *store.Store, clk *storetest.Clock, blobs blob.Store) {
	t.Helper()
	ctx := context.Background()
	user := storetest.SeedUser(t, st, "alice")
	vault := storetest.SeedVault(t, st, user.ID)
	key := "test/" + hex.EncodeToString(storetest.ChunkID(1))
	if err := blobs.Put(ctx, key, bytes.NewReader([]byte("cipher"))); err != nil {
		t.Fatal(err)
	}
	if _, err := st.InsertChunk(ctx, store.Chunk{VaultID: vault.ID, ChunkID: storetest.ChunkID(1), BlobKey: key, Size: 6}); err != nil {
		t.Fatal(err)
	}
	clk.Advance(48 * time.Hour)
}

func TestRunOnceSweepsTempFilesAfterChunkGC(t *testing.T) {
	st, clk := storetest.New(t)
	fsBlobs, err := blob.NewFS(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	blobs := &recordingBlobs{Store: fsBlobs, removed: 3}
	seedDeadChunk(t, st, clk, blobs)
	var logs bytes.Buffer
	r := jobs.New(st, blobs, jobs.Config{Interval: time.Hour, Retention: config.Retention{TrashDays: 30}, GCGrace: time.Hour},
		clk.Now, slog.New(slog.NewTextHandler(&logs, nil)))
	if err := r.RunOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(blobs.calls, ","); got != "delete,sweep" {
		t.Fatalf("blob calls = %s, want delete,sweep", got)
	}
	if blobs.olderThan != time.Hour {
		t.Errorf("olderThan = %v, want 1h", blobs.olderThan)
	}
	if !strings.Contains(logs.String(), "level=INFO msg=\"swept stale blob temp files\" removed=3") {
		t.Errorf("missing sweep log:\n%s", logs.String())
	}
}

func TestRunOnceSweepQuietWhenNothingRemoved(t *testing.T) {
	st, clk := storetest.New(t)
	fsBlobs, _ := blob.NewFS(t.TempDir())
	blobs := &recordingBlobs{Store: fsBlobs}
	var logs bytes.Buffer
	r := jobs.New(st, blobs, jobs.Config{Interval: time.Hour, GCGrace: time.Hour}, clk.Now, slog.New(slog.NewTextHandler(&logs, nil)))
	if err := r.RunOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(blobs.calls) != 1 {
		t.Fatalf("blob calls = %v, want one sweep", blobs.calls)
	}
	if strings.Contains(logs.String(), "swept") || strings.Contains(logs.String(), "level=WARN") {
		t.Errorf("unexpected log:\n%s", logs.String())
	}
}

// A failed sweep only wastes space: it is logged and the pass still succeeds.
func TestRunOnceSweepErrorIsWarning(t *testing.T) {
	st, clk := storetest.New(t)
	fsBlobs, _ := blob.NewFS(t.TempDir())
	blobs := &recordingBlobs{Store: fsBlobs, removed: 1, err: errors.New("permission denied")}
	var logs bytes.Buffer
	r := jobs.New(st, blobs, jobs.Config{Interval: time.Hour, GCGrace: time.Hour}, clk.Now, slog.New(slog.NewTextHandler(&logs, nil)))
	if err := r.RunOnce(context.Background()); err != nil {
		t.Fatalf("sweep error failed the pass: %v", err)
	}
	out := logs.String()
	if !strings.Contains(out, "level=WARN msg=\"sweep blob temp files\" err=\"permission denied\"") {
		t.Errorf("missing warning:\n%s", out)
	}
	if !strings.Contains(out, "removed=1") {
		t.Errorf("partial removals not logged:\n%s", out)
	}
}

func TestRunOnceWithoutTempSweeper(t *testing.T) {
	st, clk := storetest.New(t)
	fsBlobs, _ := blob.NewFS(t.TempDir())
	blobs := plainBlobs{fsBlobs}
	if _, ok := any(blobs).(jobs.TempSweeper); ok {
		t.Fatal("setup: plainBlobs must not be a TempSweeper")
	}
	seedDeadChunk(t, st, clk, blobs)
	r := jobs.New(st, blobs, jobs.Config{Interval: time.Hour, Retention: config.Retention{TrashDays: 30}, GCGrace: time.Hour}, clk.Now, discard())
	if err := r.RunOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func TestRunOnceWithoutLeaseDoesNotSweep(t *testing.T) {
	ctx := context.Background()
	st, clk := storetest.New(t)
	if ok, _ := st.AcquireLease(ctx, "maintenance", "other-replica", time.Hour); !ok {
		t.Fatal("setup: lease not taken")
	}
	fsBlobs, _ := blob.NewFS(t.TempDir())
	blobs := &recordingBlobs{Store: fsBlobs}
	r := jobs.New(st, blobs, jobs.Config{Interval: time.Hour, GCGrace: time.Hour}, clk.Now, discard())
	if err := r.RunOnce(ctx); err != nil {
		t.Fatal(err)
	}
	if len(blobs.calls) != 0 {
		t.Fatalf("blob calls without the lease: %v", blobs.calls)
	}
}
