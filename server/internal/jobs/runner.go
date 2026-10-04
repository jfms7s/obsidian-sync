// Package jobs runs periodic maintenance: retention pruning, chunk garbage
// collection, then removal of stale blob temp files. A database lease makes
// one replica run it at a time.
package jobs

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/jfms7s/obsidian-sync/server/internal/blob"
	"github.com/jfms7s/obsidian-sync/server/internal/config"
	"github.com/jfms7s/obsidian-sync/server/internal/ids"
	"github.com/jfms7s/obsidian-sync/server/internal/store"
)

const (
	leaseName       = "maintenance"
	gcBatch         = 500
	maxGCBatches    = 100
	defaultInterval = time.Hour
	releaseTimeout  = 5 * time.Second
	// staleTempAge is how old a blob temp file must be before it is swept;
	// younger ones may belong to a Put still running in some process.
	staleTempAge = time.Hour
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
	DeleteDeadChunk(ctx context.Context, c store.DeadChunk, touchedBeforeMs int64) (bool, error)
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
	if err := r.st.ReleaseLease(ctx, leaseName, r.holder); err != nil {
		r.log.Warn("release maintenance lease", "err", err)
	}
}

func (r *Runner) RunOnce(ctx context.Context) error {
	ok, err := r.st.AcquireLease(ctx, leaseName, r.holder, 2*r.cfg.Interval)
	if err != nil {
		return fmt.Errorf("acquire lease: %w", err)
	}
	if !ok {
		return nil
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
		return fmt.Errorf("prune: %w", err)
	}
	collected, err := r.collectChunks(ctx, now.Add(-r.cfg.GCGrace).UnixMilli())
	if err != nil {
		return fmt.Errorf("collect chunks: %w", err)
	}
	r.log.Info("maintenance done",
		"versions_pruned", stats.VersionsDeleted, "files_purged", stats.FilesPurged, "chunks_deleted", collected)
	r.sweepTemp(ctx)
	return nil
}

// sweepTemp removes stale blob temp files if the blob store supports it. It
// runs under the lease, whose TTL (two intervals) leaves ample room for one
// walk of the blob tree. Failures are only wasted space, so they are logged
// rather than failing the pass.
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
		for _, c := range dead {
			ok, err := r.st.DeleteDeadChunk(ctx, c, cutoffMs)
			if err != nil {
				return deleted, err
			}
			if !ok {
				continue
			}
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
