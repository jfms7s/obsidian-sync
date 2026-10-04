// Package jobs runs periodic maintenance: retention pruning, then chunk
// garbage collection. A database lease makes one replica run it at a time.
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
	leaseName    = "maintenance"
	gcBatch      = 500
	maxGCBatches = 100
)

type Store interface {
	AcquireLease(ctx context.Context, name, holder string, ttl time.Duration) (bool, error)
	Prune(ctx context.Context, p store.PrunePolicy) (store.PruneStats, error)
	DeadChunks(ctx context.Context, touchedBeforeMs int64, limit int) ([]store.DeadChunk, error)
	DeleteDeadChunk(ctx context.Context, c store.DeadChunk, touchedBeforeMs int64) (bool, error)
}

type Config struct {
	Interval  time.Duration
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
	return &Runner{st: st, blobs: blobs, cfg: cfg, holder: ids.New(), now: now, log: log}
}

// Run calls RunOnce immediately and then every Interval until ctx ends.
func (r *Runner) Run(ctx context.Context) {
	ticker := time.NewTicker(r.cfg.Interval)
	defer ticker.Stop()
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
	stats, err := r.st.Prune(ctx, store.PrunePolicy{
		HistoryCutoffMs: now.Add(-time.Duration(r.cfg.Retention.HistoryDays) * day).UnixMilli(),
		MaxVersions:     r.cfg.Retention.HistoryMaxVersions,
		TrashCutoffMs:   now.Add(-time.Duration(r.cfg.Retention.TrashDays) * day).UnixMilli(),
	})
	if err != nil {
		return fmt.Errorf("prune: %w", err)
	}
	collected, err := r.collectChunks(ctx, now.Add(-r.cfg.GCGrace).UnixMilli())
	if err != nil {
		return fmt.Errorf("collect chunks: %w", err)
	}
	r.log.Info("maintenance done",
		"versions_pruned", stats.VersionsDeleted, "files_purged", stats.FilesPurged, "chunks_deleted", collected)
	return nil
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
