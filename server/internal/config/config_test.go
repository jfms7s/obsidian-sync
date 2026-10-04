package config_test

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/jfms7s/obsidian-sync/server/internal/config"
)

func env(m map[string]string) func(string) string {
	return func(k string) string { return m[k] }
}

func writeFile(t *testing.T, content string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "obsync.yaml")
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestLoadDefaults(t *testing.T) {
	cfg, err := config.Load("", env(nil))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Listen != ":8080" {
		t.Errorf("Listen = %q", cfg.Listen)
	}
	if cfg.DatabaseURL != "file:/data/meta.db" {
		t.Errorf("DatabaseURL = %q", cfg.DatabaseURL)
	}
	if cfg.BlobFSDir != "/data/blobs" {
		t.Errorf("BlobFSDir = %q", cfg.BlobFSDir)
	}
	if cfg.DefaultQuotaBytes != 10<<30 || cfg.MaxFileSizeBytes != 2<<30 {
		t.Errorf("quota/max = %d/%d", cfg.DefaultQuotaBytes, cfg.MaxFileSizeBytes)
	}
	if cfg.Retention != (config.Retention{HistoryDays: 30, HistoryMaxVersions: 0, TrashDays: 30}) {
		t.Errorf("Retention = %+v", cfg.Retention)
	}
}

func TestLoadYAMLThenEnv(t *testing.T) {
	path := writeFile(t, "listen: \":9000\"\ndata_dir: /srv/obsync\nretention:\n  trash_days: 7\n")
	cfg, err := config.Load(path, env(map[string]string{"OBSYNC_LISTEN": ":9100"}))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Listen != ":9100" {
		t.Errorf("env should override YAML, Listen = %q", cfg.Listen)
	}
	if cfg.DataDir != "/srv/obsync" || cfg.DatabaseURL != "file:/srv/obsync/meta.db" {
		t.Errorf("DataDir/DatabaseURL = %q/%q", cfg.DataDir, cfg.DatabaseURL)
	}
	if cfg.Retention.TrashDays != 7 || cfg.Retention.HistoryDays != 30 {
		t.Errorf("Retention = %+v", cfg.Retention)
	}
}

func TestLoadEmptyYAMLFile(t *testing.T) {
	if _, err := config.Load(writeFile(t, ""), env(nil)); err != nil {
		t.Fatalf("empty file should mean defaults: %v", err)
	}
}

func TestLoadRejectsUnknownYAMLField(t *testing.T) {
	_, err := config.Load(writeFile(t, "lisen: \":9000\"\n"), env(nil))
	if err == nil || !strings.Contains(err.Error(), "lisen") {
		t.Fatalf("err = %v, want mention of the unknown field", err)
	}
}

func TestLoadRejectsBadEnvInteger(t *testing.T) {
	_, err := config.Load("", env(map[string]string{"OBSYNC_TRASH_DAYS": "seven"}))
	if err == nil || !strings.Contains(err.Error(), "OBSYNC_TRASH_DAYS") {
		t.Fatalf("err = %v", err)
	}
}

func TestValidateRejectsUnavailableModes(t *testing.T) {
	_, err := config.Load("", env(map[string]string{"OBSYNC_CLUSTER": "true", "OBSYNC_BLOB_BACKEND": "s3"}))
	if err == nil {
		t.Fatal("expected an error")
	}
	for _, want := range []string{"cluster mode is not available yet", `blob_backend "s3"`} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error %q does not mention %q", err, want)
		}
	}
}

func TestValidateRejectsBadDatabaseScheme(t *testing.T) {
	_, err := config.Load("", env(map[string]string{"OBSYNC_DATABASE_URL": "postgres://db/obsync"}))
	if err == nil || !strings.Contains(err.Error(), `"postgres"`) {
		t.Fatalf("err = %v", err)
	}
}

func TestValidateRejectsNonPositiveLimits(t *testing.T) {
	_, err := config.Load("", env(map[string]string{"OBSYNC_DEFAULT_QUOTA_BYTES": "0", "OBSYNC_GC_GRACE_HOURS": "0"}))
	if err == nil {
		t.Fatal("expected an error")
	}
	for _, want := range []string{"default_quota_bytes", "gc_grace_hours"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error %q does not mention %q", err, want)
		}
	}
}

func TestValidateRejectsOverflowingDurations(t *testing.T) {
	_, err := config.Load("", env(map[string]string{
		"OBSYNC_HISTORY_DAYS":          "999999",
		"OBSYNC_GC_GRACE_HOURS":        "99999999",
		"OBSYNC_JOBS_INTERVAL_MINUTES": "99999999",
	}))
	if err == nil {
		t.Fatal("expected an error")
	}
	for _, want := range []string{"retention days", "gc_grace_hours", "jobs_interval_minutes"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error %q does not mention %q", err, want)
		}
	}
}

func TestValidateRetentionZeroes(t *testing.T) {
	cfg, err := config.Load("", env(map[string]string{"OBSYNC_HISTORY_DAYS": "0", "OBSYNC_HISTORY_MAX_VERSIONS": "0"}))
	if err != nil {
		t.Fatalf("history_days 0 (no age limit) must be accepted: %v", err)
	}
	if cfg.Retention.HistoryDays != 0 {
		t.Fatalf("Retention = %+v", cfg.Retention)
	}
	_, err = config.Load("", env(map[string]string{"OBSYNC_TRASH_DAYS": "0"}))
	if err == nil || !strings.Contains(err.Error(), "trash_days") {
		t.Fatalf("err = %v, want trash_days rejected", err)
	}
}
