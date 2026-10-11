// Package jobs runs periodic maintenance: retention pruning, chunk garbage
// collection, then (daily) removal of stale blob temp files. A database lease makes
// one process run it at a time, and lets obsync admin export keep it from
// deleting anything while a backup is taken.
package jobs

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/jfms7s/obsidian-sync/server/internal/blob"
	"github.com/jfms7s/obsidian-sync/server/internal/config"
	"github.com/jfms7s/obsidian-sync/server/internal/ids"
	"github.com/jfms7s/obsidian-sync/server/internal/store"
)

// LeaseName is the database lease a maintenance pass holds. Anything that
// must not see chunks or versions deleted under it (obsync admin export)
// holds the same lease.
const LeaseName = "maintenance"

const (
	gcBatch         = 500
	maxGCBatches    = 100
	defaultInterval = time.Hour
	releaseTimeout  = 5 * time.Second
	// staleTempAge is how old a blob temp file must be before it is swept;
	// younger ones may belong to a Put still running in some process.
	staleTempAge = time.Hour
	// sweepInterval is the least time between two temp sweeps. A sweep walks
	// the whole blob tree, and temp files only appear after a crash.
	sweepInterval = 24 * time.Hour
)

// TempSweeper is implemented by blob stores that can leave temp files behind
// after a crash (blob.FS). The runner sweeps them once per pass when the
// store supports it. blob.FS is single-node only; clustered deployments use
// object storage, which has no temp files to sweep.
type TempSweeper interface {
	SweepTemp(ctx context.Context, olderThan time.Duration) (int, error)
}

type Store interface {
	AcquireLease(ctx context.Context, name, holder string, ttl time.Duration) (bool, error)
	ReleaseLease(ctx context.Context, name, holder string) error
	Prune(ctx context.Context, p store.PrunePolicy) (store.PruneStats, error)
	DeadChunks(ctx context.Context, touchedBeforeMs int64, limit int) ([]store.DeadChunk, error)
	DeleteDeadChunks(ctx context.Context, cs []store.DeadChunk, touchedBeforeMs int64) ([]store.DeadChunk, error)
}

type Config struct {
	Interval  time.Duration // <= 0 means one hour
	Retention config.Retention
	GCGrace   time.Duration
}

type Runner struct {
	st     Store
	blobs  blob.Store
	cfg    Config
	holder string
	now    func() time.Time
	log    *slog.Logger

	lastSweep time.Time // zero until the first sweep
}

func New(st Store, blobs blob.Store, cfg Config, now func() time.Time, log *slog.Logger) *Runner {
	if cfg.Interval <= 0 {
		cfg.Interval = defaultInterval
	}
	return &Runner{st: st, blobs: blobs, cfg: cfg, holder: ids.New(), now: now, log: log}
}

// Run calls RunOnce immediately and then every Interval until ctx ends. On
// return it releases the lease if it holds it.
func (r *Runner) Run(ctx context.Context) {
	ticker := time.NewTicker(r.cfg.Interval)
	defer ticker.Stop()
	defer r.releaseLease(ctx)
	for {
		if err := r.RunOnce(ctx); err != nil && ctx.Err() == nil {
			r.log.Error("maintenance failed", "err", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

// releaseLease gives the lease up so a restarted or other replica need not
// wait for it to expire. Best effort: a failure only delays maintenance.
func (r *Runner) releaseLease(ctx context.Context) {
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), releaseTimeout)
	defer cancel()
	if err := r.st.ReleaseLease(ctx, LeaseName, r.holder); err != nil {
		r.log.Warn("release maintenance lease", "err", err)
	}
}

// Report is what one maintenance pass did.
type Report struct {
	VersionsPruned int // by history retention or trash purge
	FilesPurged    int // deleted files whose trash time ran out
	ChunksDeleted  int
}

// ErrLeaseHeld means another process holds the maintenance lease: on a
// single node, the running server, which keeps it while it runs.
var ErrLeaseHeld = errors.New("another process holds the maintenance lease")

// RunOnce runs one pass if this runner can take the lease, then gives the
// lease back, so between passes an export or an on-demand pass can take it.
// Without the lease it does nothing.
func (r *Runner) RunOnce(ctx context.Context) error {
	_, ran, err := r.pass(ctx)
	if ran {
		r.releaseLease(ctx)
	}
	return err
}

// RunPass runs one pass on demand (obsync admin maintenance run) and gives
// the lease back afterwards. It returns ErrLeaseHeld, doing nothing, while
// another process holds the lease.
func (r *Runner) RunPass(ctx context.Context) (Report, error) {
	rep, ran, err := r.pass(ctx)
	if !ran {
		if err == nil {
			err = ErrLeaseHeld
		}
		return Report{}, err
	}
	r.releaseLease(ctx)
	return rep, err
}

// pass takes the lease and runs one pass; ran reports whether it got the lease.
func (r *Runner) pass(ctx context.Context) (rep Report, ran bool, err error) {
	ok, err := r.st.AcquireLease(ctx, LeaseName, r.holder, 2*r.cfg.Interval)
	if err != nil {
		return Report{}, false, fmt.Errorf("acquire lease: %w", err)
	}
	if !ok {
		return Report{}, false, nil
	}
	now := r.now()
	day := 24 * time.Hour
	policy := store.PrunePolicy{
		MaxVersions:   r.cfg.Retention.HistoryMaxVersions,
		TrashCutoffMs: now.Add(-time.Duration(r.cfg.Retention.TrashDays) * day).UnixMilli(),
	}
	if r.cfg.Retention.HistoryDays > 0 { // 0 = no age limit
		policy.HistoryCutoffMs = now.Add(-time.Duration(r.cfg.Retention.HistoryDays) * day).UnixMilli()
	}
	stats, err := r.st.Prune(ctx, policy)
	if err != nil {
		return Report{}, true, fmt.Errorf("prune: %w", err)
	}
	rep = Report{VersionsPruned: stats.VersionsDeleted, FilesPurged: stats.FilesPurged}
	rep.ChunksDeleted, err = r.collectChunks(ctx, now.Add(-r.cfg.GCGrace).UnixMilli())
	if err != nil {
		return rep, true, fmt.Errorf("collect chunks: %w", err)
	}
	r.log.Info("maintenance done",
		"versions_pruned", rep.VersionsPruned, "files_purged", rep.FilesPurged, "chunks_deleted", rep.ChunksDeleted)
	if r.lastSweep.IsZero() || now.Sub(r.lastSweep) >= sweepInterval {
		r.sweepTemp(ctx)
		r.lastSweep = now
	}
	return rep, true, nil
}

// sweepTemp removes stale blob temp files if the blob store supports it. A
// runner calls it on its first pass and then at most once per sweepInterval.
// It runs under the lease, whose TTL (two intervals) leaves ample room for
// one walk of the blob tree. Failures are only wasted space, so they are
// logged rather than failing the pass.
func (r *Runner) sweepTemp(ctx context.Context) {
	sw, ok := r.blobs.(TempSweeper)
	if !ok {
		return
	}
	removed, err := sw.SweepTemp(ctx, staleTempAge)
	if removed > 0 {
		r.log.Info("swept stale blob temp files", "removed", removed)
	}
	if err != nil && ctx.Err() == nil {
		r.log.Warn("sweep blob temp files", "err", err)
	}
}

func (r *Runner) collectChunks(ctx context.Context, cutoffMs int64) (int, error) {
	deleted := 0
	for i := 0; i < maxGCBatches; i++ {
		dead, err := r.st.DeadChunks(ctx, cutoffMs, gcBatch)
		if err != nil {
			return deleted, err
		}
		gone, err := r.st.DeleteDeadChunks(ctx, dead, cutoffMs)
		if err != nil {
			return deleted, err
		}
		for _, c := range gone {
			deleted++
			if err := r.blobs.Delete(ctx, c.BlobKey); err != nil {
				// The row is gone, so nothing can reach this blob; it is only wasted space.
				r.log.Warn("delete chunk blob", "blob_key", c.BlobKey, "err", err)
			}
		}
		if len(dead) < gcBatch {
			break
		}
	}
	return deleted, nil
}
