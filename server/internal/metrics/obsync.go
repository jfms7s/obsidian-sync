package metrics

import (
	"context"
	"net/http"
	"runtime"
	rtmetrics "runtime/metrics"
	"time"
)

// Label values. Each label takes only the values listed here.
const (
	CommitOK           = "ok"
	CommitConflict     = "conflict"
	CommitStaleEpoch   = "stale_epoch"
	CommitMissingChunk = "missing_chunk"
	CommitInvalid      = "invalid"

	LimiterDevice   = "device"
	LimiterIP       = "ip"
	LimiterBadToken = "bad_token"
	LimiterLogin    = "login"

	LoginOK     = "ok"
	LoginFailed = "failed"
	LoginLocked = "locked"

	MaintenanceOK           = "ok"
	MaintenanceFailed       = "failed"
	MaintenanceSkippedLease = "skipped_lease"
)

// Stats are the server-wide counts computed at scrape time.
type Stats struct {
	Users, Vaults, DevicesActive, StorageUsedBytes int64
}

// Obsync is obsync's metric set. A nil *Obsync records nothing, so
// components hold one whether or not metrics are enabled.
type Obsync struct {
	reg *Registry

	websockets       *Gauge
	commits          *CounterVec
	chunkUploads     *Counter
	chunkUploadBytes *Counter
	chunkDownloads   *Counter
	quotaRefusals    *Counter
	rateLimited      *CounterVec
	logins           *CounterVec
	maintenanceRuns  *CounterVec
	maintenanceLast  *Gauge
	versionsPruned   *Counter
	filesPurged      *Counter
	chunksDeleted    *Counter
}

// NewObsync declares every obsync metric. stats is called once per scrape
// for the server-wide counts.
func NewObsync(version string, stats func(context.Context) (Stats, error)) *Obsync {
	r := NewRegistry()
	o := &Obsync{
		reg:              r,
		websockets:       r.NewGauge("obsync_websocket_connections", "Open WebSocket connections."),
		commits:          r.NewCounterVec("obsync_commits_total", "Commits by result.", "result", CommitOK, CommitConflict, CommitStaleEpoch, CommitMissingChunk, CommitInvalid),
		chunkUploads:     r.NewCounter("obsync_chunk_uploads_total", "Chunks stored (new chunks only)."),
		chunkUploadBytes: r.NewCounter("obsync_chunk_upload_bytes_total", "Encrypted bytes of the chunks stored."),
		chunkDownloads:   r.NewCounter("obsync_chunk_downloads_total", "Chunks served."),
		quotaRefusals:    r.NewCounter("obsync_quota_refusals_total", "Uploads refused because the account's quota is used up."),
		rateLimited:      r.NewCounterVec("obsync_rate_limited_total", "Requests refused by a rate limiter.", "limiter", LimiterDevice, LimiterIP, LimiterBadToken, LimiterLogin),
		logins:           r.NewCounterVec("obsync_logins_total", "Login attempts by result.", "result", LoginOK, LoginFailed, LoginLocked),
		maintenanceRuns:  r.NewCounterVec("obsync_maintenance_runs_total", "Maintenance passes by result.", "result", MaintenanceOK, MaintenanceFailed, MaintenanceSkippedLease),
		maintenanceLast:  r.NewGauge("obsync_maintenance_last_success_timestamp_seconds", "Unix time of the last maintenance pass that succeeded."),
		versionsPruned:   r.NewCounter("obsync_maintenance_versions_pruned_total", "Versions removed by history retention or trash purge."),
		filesPurged:      r.NewCounter("obsync_maintenance_files_purged_total", "Deleted files whose time in the trash ran out."),
		chunksDeleted:    r.NewCounter("obsync_maintenance_chunks_deleted_total", "Chunks no version references any more, deleted."),
	}
	r.NewInfo("obsync_build_info", "The running build; always 1.", "version", version)
	scrapeErrors := r.NewCounter("obsync_scrape_errors_total", "Scrapes whose database counts could not be read (those gauges were left out).")
	r.NewScrapeGauges(func(ctx context.Context) ([]float64, error) {
		s, err := stats(ctx)
		if err != nil {
			return nil, err
		}
		return []float64{float64(s.Users), float64(s.Vaults), float64(s.DevicesActive), float64(s.StorageUsedBytes)}, nil
	}, scrapeErrors,
		Desc{"obsync_users", "Accounts."},
		Desc{"obsync_vaults", "Vaults."},
		Desc{"obsync_devices_active", "Signed-in devices (not revoked)."},
		Desc{"obsync_storage_used_bytes", "Encrypted chunk bytes stored, over all vaults, history and trash included."},
	)
	r.NewGaugeFunc("obsync_go_goroutines", "Goroutines.", func() float64 { return float64(runtime.NumGoroutine()) })
	r.NewGaugeFunc("obsync_go_heap_inuse_bytes", "Heap memory in use (objects and unused space in in-use spans).", heapInUse)
	return o
}

var heapSamples = []string{"/memory/classes/heap/objects:bytes", "/memory/classes/heap/unused:bytes"}

func heapInUse() float64 {
	s := make([]rtmetrics.Sample, len(heapSamples))
	for i, name := range heapSamples {
		s[i].Name = name
	}
	rtmetrics.Read(s)
	var total float64
	for _, x := range s {
		if x.Value.Kind() == rtmetrics.KindUint64 {
			total += float64(x.Value.Uint64())
		}
	}
	return total
}

// Handler serves GET /metrics.
func (o *Obsync) Handler() http.Handler { return o.reg.Handler() }

func (o *Obsync) WebSocketOpened() {
	if o != nil {
		o.websockets.Add(1)
	}
}

func (o *Obsync) WebSocketClosed() {
	if o != nil {
		o.websockets.Add(-1)
	}
}

// Commit counts one commit's outcome (one of the Commit* constants).
func (o *Obsync) Commit(result string) {
	if o != nil {
		o.commits.With(result).Inc()
	}
}

func (o *Obsync) ChunkStored(bytes int64) {
	if o != nil && bytes >= 0 {
		o.chunkUploads.Inc()
		o.chunkUploadBytes.Add(uint64(bytes))
	}
}

func (o *Obsync) ChunkServed() {
	if o != nil {
		o.chunkDownloads.Inc()
	}
}

func (o *Obsync) QuotaRefused() {
	if o != nil {
		o.quotaRefusals.Inc()
	}
}

// RateLimited counts one refusal by a limiter (one of the Limiter* constants).
func (o *Obsync) RateLimited(limiter string) {
	if o != nil {
		o.rateLimited.With(limiter).Inc()
	}
}

// Login counts one login attempt's result (one of the Login* constants).
func (o *Obsync) Login(result string) {
	if o != nil {
		o.logins.With(result).Inc()
	}
}

// MaintenanceSkipped counts a pass that did not run because another process
// held the lease.
func (o *Obsync) MaintenanceSkipped() {
	if o != nil {
		o.maintenanceRuns.With(MaintenanceSkippedLease).Inc()
	}
}

// MaintenanceFailed counts a pass that ran and failed.
func (o *Obsync) MaintenanceFailed() {
	if o != nil {
		o.maintenanceRuns.With(MaintenanceFailed).Inc()
	}
}

// MaintenanceDone counts a pass that succeeded at now and what it removed.
func (o *Obsync) MaintenanceDone(now time.Time, versionsPruned, filesPurged, chunksDeleted int) {
	if o == nil {
		return
	}
	o.maintenanceRuns.With(MaintenanceOK).Inc()
	o.maintenanceLast.Set(float64(now.UnixMilli()) / 1000)
	o.versionsPruned.Add(uint64(max(versionsPruned, 0)))
	o.filesPurged.Add(uint64(max(filesPurged, 0)))
	o.chunksDeleted.Add(uint64(max(chunksDeleted, 0)))
}
