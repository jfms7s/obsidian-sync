package metrics_test

import (
	"context"
	"errors"
	"io"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/jfms7s/obsidian-sync/server/internal/metrics"
)

func scrapeObsync(t *testing.T, o *metrics.Obsync) string {
	t.Helper()
	srv := httptest.NewServer(o.Handler())
	defer srv.Close()
	resp, err := srv.Client().Get(srv.URL + "/metrics")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return string(b)
}

// Every metric of the agreed list is exposed.
func TestObsyncMetricNames(t *testing.T) {
	o := metrics.NewObsync("0.2.0", func(context.Context) (metrics.Stats, error) {
		return metrics.Stats{Users: 3, Vaults: 4, DevicesActive: 5, StorageUsedBytes: 6}, nil
	})
	got := scrapeObsync(t, o)
	for _, name := range []string{
		`obsync_build_info{version="0.2.0"} 1`, "obsync_websocket_connections 0",
		`obsync_commits_total{result="ok"} 0`, `obsync_commits_total{result="conflict"} 0`, `obsync_commits_total{result="stale_epoch"} 0`,
		`obsync_commits_total{result="missing_chunk"} 0`, `obsync_commits_total{result="invalid"} 0`,
		"obsync_chunk_uploads_total 0", "obsync_chunk_upload_bytes_total 0", "obsync_chunk_downloads_total 0", "obsync_quota_refusals_total 0",
		`obsync_rate_limited_total{limiter="device"} 0`, `obsync_rate_limited_total{limiter="ip"} 0`,
		`obsync_rate_limited_total{limiter="bad_token"} 0`, `obsync_rate_limited_total{limiter="login"} 0`,
		`obsync_logins_total{result="ok"} 0`, `obsync_logins_total{result="failed"} 0`, `obsync_logins_total{result="locked"} 0`,
		`obsync_maintenance_runs_total{result="ok"} 0`, `obsync_maintenance_runs_total{result="failed"} 0`, `obsync_maintenance_runs_total{result="skipped_lease"} 0`,
		"obsync_maintenance_last_success_timestamp_seconds 0", "obsync_maintenance_versions_pruned_total 0",
		"obsync_maintenance_files_purged_total 0", "obsync_maintenance_chunks_deleted_total 0",
		"obsync_users 3", "obsync_vaults 4", "obsync_devices_active 5", "obsync_storage_used_bytes 6",
		"obsync_go_goroutines ", "obsync_go_heap_inuse_bytes ", "obsync_scrape_errors_total 0",
	} {
		if !strings.Contains(got, "\n"+name) {
			t.Errorf("missing %q in:\n%s", name, got)
		}
	}
}

func TestObsyncEvents(t *testing.T) {
	o := metrics.NewObsync("dev", func(context.Context) (metrics.Stats, error) { return metrics.Stats{}, errors.New("down") })
	o.WebSocketOpened()
	o.WebSocketOpened()
	o.WebSocketClosed()
	o.Commit(metrics.CommitConflict)
	o.ChunkStored(100)
	o.ChunkStored(20)
	o.ChunkServed()
	o.QuotaRefused()
	o.RateLimited(metrics.LimiterLogin)
	o.Login(metrics.LoginLocked)
	o.MaintenanceSkipped()
	o.MaintenanceDone(time.Unix(1_700_000_000, 500_000_000), 3, 2, 1)
	got := scrapeObsync(t, o)
	for _, want := range []string{
		"obsync_websocket_connections 1", `obsync_commits_total{result="conflict"} 1`, "obsync_chunk_uploads_total 2",
		"obsync_chunk_upload_bytes_total 120", "obsync_chunk_downloads_total 1", "obsync_quota_refusals_total 1",
		`obsync_rate_limited_total{limiter="login"} 1`, `obsync_logins_total{result="locked"} 1`,
		`obsync_maintenance_runs_total{result="skipped_lease"} 1`, `obsync_maintenance_runs_total{result="ok"} 1`,
		"obsync_maintenance_last_success_timestamp_seconds 1.7000000005e+09", "obsync_maintenance_versions_pruned_total 3",
		"obsync_maintenance_files_purged_total 2", "obsync_maintenance_chunks_deleted_total 1", "obsync_scrape_errors_total 1",
	} {
		if !strings.Contains(got, "\n"+want+"\n") {
			t.Errorf("missing %q in:\n%s", want, got)
		}
	}
	if strings.Contains(got, "obsync_users") {
		t.Errorf("database gauges shown although their collection failed:\n%s", got)
	}

	var none *metrics.Obsync
	none.Commit(metrics.CommitOK)
	none.MaintenanceDone(time.Now(), 1, 1, 1)
	none.WebSocketOpened()
}
