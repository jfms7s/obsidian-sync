package config_test

import (
	"bytes"
	"log/slog"
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

func TestLoadRejectsMultipleYAMLDocuments(t *testing.T) {
	_, err := config.Load(writeFile(t, "listen: \":9000\"\n---\nlisten: \":9100\"\n"), env(nil))
	if err == nil || !strings.Contains(err.Error(), "config file must contain a single YAML document") {
		t.Fatalf("err = %v, want single-document error", err)
	}
	// A lone document with an explicit start marker is still fine.
	if _, err := config.Load(writeFile(t, "---\nlisten: \":9000\"\n"), env(nil)); err != nil {
		t.Fatalf("single document with ---: %v", err)
	}
}

func TestLogValueRedactsCredentials(t *testing.T) {
	cases := map[string]string{
		"userinfo password": "libsql://admin:hunter2-secret@db.example.com/obsync",
		"authToken query":   "libsql://db.example.com/obsync?authToken=hunter2-secret&tls=1",
		"unparseable":       "libsql://db example.com/%zz?authToken=hunter2-secret",
		"fragment":          "libsql://h#authToken=hunter2-secret",
		"access_token":      "libsql://h/db?access_token=hunter2-secret",
		"client_secret":     "libsql://h/db?Client_Secret=hunter2-secret",
		"api key":           "libsql://h/db?apiKey=hunter2-secret",
		"db password":       "libsql://h/db?DB_PASSWORD=hunter2-secret",
		"jwt":               "libsql://h/db?JWT=hunter2-secret",
	}
	for name, dbURL := range cases {
		t.Run(name, func(t *testing.T) {
			cfg := config.Defaults()
			cfg.DatabaseURL = dbURL
			cfg.DatabaseAuthToken = "tok-hunter2-secret"
			for _, h := range []func(*bytes.Buffer) slog.Handler{
				func(b *bytes.Buffer) slog.Handler { return slog.NewTextHandler(b, nil) },
				func(b *bytes.Buffer) slog.Handler { return slog.NewJSONHandler(b, nil) },
			} {
				var buf bytes.Buffer
				slog.New(h(&buf)).Info("config", "cfg", cfg)
				out := buf.String()
				if strings.Contains(out, "hunter2") {
					t.Fatalf("log leaks a credential: %s", out)
				}
				for _, want := range []string{"listen", ":8080", "REDACTED"} {
					if !strings.Contains(out, want) {
						t.Errorf("log %q does not contain %q", out, want)
					}
				}
			}
		})
	}
	// An unset token is not reported as redacted, and a plain URL is kept.
	cfg := config.Defaults()
	cfg.DatabaseURL = "file:/data/meta.db"
	var buf bytes.Buffer
	slog.New(slog.NewTextHandler(&buf, nil)).Info("config", "cfg", cfg)
	if strings.Contains(buf.String(), "REDACTED") || !strings.Contains(buf.String(), "file:/data/meta.db") {
		t.Fatalf("log = %s", buf.String())
	}
}

func TestRateLimitDefaults(t *testing.T) {
	cfg, err := config.Load("", env(nil))
	if err != nil {
		t.Fatal(err)
	}
	want := config.RateLimit{DeviceRPS: 100, DeviceBurst: 1000, IPRPS: 1, IPBurst: 10}
	if cfg.RateLimit != want {
		t.Errorf("RateLimit = %+v, want %+v", cfg.RateLimit, want)
	}
	if len(cfg.TrustedProxies) != 0 || len(cfg.TrustedProxyPrefixes()) != 0 {
		t.Errorf("TrustedProxies = %v, want none", cfg.TrustedProxies)
	}
}

func TestRateLimitYAMLAndEnv(t *testing.T) {
	path := writeFile(t, "rate_limit:\n  device_rps: 5\n  device_burst: 50\n  ip_rps: 0.5\ntrusted_proxies: [\"172.16.0.0/12\"]\n")
	cfg, err := config.Load(path, env(map[string]string{
		"OBSYNC_RATE_LIMIT_IP_BURST":   "3",
		"OBSYNC_RATE_LIMIT_DEVICE_RPS": "7.5",
		"OBSYNC_TRUSTED_PROXIES":       " 10.0.0.0/8, fd00::/8 ,192.168.1.1 ",
	}))
	if err != nil {
		t.Fatal(err)
	}
	want := config.RateLimit{DeviceRPS: 7.5, DeviceBurst: 50, IPRPS: 0.5, IPBurst: 3}
	if cfg.RateLimit != want {
		t.Errorf("RateLimit = %+v, want %+v", cfg.RateLimit, want)
	}
	got := cfg.TrustedProxyPrefixes()
	wantP := []string{"10.0.0.0/8", "fd00::/8", "192.168.1.1/32"}
	if len(got) != len(wantP) {
		t.Fatalf("prefixes = %v", got)
	}
	for i := range got {
		if got[i].String() != wantP[i] {
			t.Errorf("prefix %d = %v, want %s", i, got[i], wantP[i])
		}
	}
}

func TestRateLimitZeroDisables(t *testing.T) {
	cfg, err := config.Load("", env(map[string]string{"OBSYNC_RATE_LIMIT_DEVICE_RPS": "0", "OBSYNC_RATE_LIMIT_IP_RPS": "0"}))
	if err != nil {
		t.Fatalf("0 must disable, not fail: %v", err)
	}
	if cfg.RateLimit.DeviceRPS != 0 || cfg.RateLimit.IPRPS != 0 {
		t.Fatalf("RateLimit = %+v", cfg.RateLimit)
	}
}

func TestRateLimitValidation(t *testing.T) {
	for name, tc := range map[string]struct {
		env  map[string]string
		want string
	}{
		"bad float":         {map[string]string{"OBSYNC_RATE_LIMIT_DEVICE_RPS": "fast"}, "OBSYNC_RATE_LIMIT_DEVICE_RPS"},
		"bad int":           {map[string]string{"OBSYNC_RATE_LIMIT_IP_BURST": "1.5"}, "OBSYNC_RATE_LIMIT_IP_BURST"},
		"negative rps":      {map[string]string{"OBSYNC_RATE_LIMIT_IP_RPS": "-1"}, "rate_limit.ip_rps"},
		"NaN rps":           {map[string]string{"OBSYNC_RATE_LIMIT_DEVICE_RPS": "NaN"}, "rate_limit.device_rps"},
		"huge rps":          {map[string]string{"OBSYNC_RATE_LIMIT_DEVICE_RPS": "1e9"}, "rate_limit.device_rps"},
		"tiny rps":          {map[string]string{"OBSYNC_RATE_LIMIT_IP_RPS": "1e-9"}, "rate_limit.ip_rps"},
		"negative burst":    {map[string]string{"OBSYNC_RATE_LIMIT_DEVICE_BURST": "-5"}, "rate_limit.device_burst"},
		"zero burst":        {map[string]string{"OBSYNC_RATE_LIMIT_IP_BURST": "0"}, "rate_limit.ip_burst"},
		"huge burst":        {map[string]string{"OBSYNC_RATE_LIMIT_IP_BURST": "99999999"}, "rate_limit.ip_burst"},
		"bad CIDR":          {map[string]string{"OBSYNC_TRUSTED_PROXIES": "10.0.0.0/8,10.0.0.0/33"}, "trusted_proxies"},
		"hostname in proxy": {map[string]string{"OBSYNC_TRUSTED_PROXIES": "caddy"}, "trusted_proxies"},
	} {
		t.Run(name, func(t *testing.T) {
			_, err := config.Load("", env(tc.env))
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("err = %v, want mention of %q", err, tc.want)
			}
		})
	}
	// A zero burst is fine when that limiter is disabled.
	if _, err := config.Load("", env(map[string]string{"OBSYNC_RATE_LIMIT_IP_RPS": "0", "OBSYNC_RATE_LIMIT_IP_BURST": "0"})); err != nil {
		t.Fatalf("disabled limiter with burst 0: %v", err)
	}
}

func TestLogValueIncludesRateLimit(t *testing.T) {
	cfg := config.Defaults()
	cfg.TrustedProxies = []string{"10.0.0.0/8"}
	var buf bytes.Buffer
	slog.New(slog.NewTextHandler(&buf, nil)).Info("config", "cfg", cfg)
	for _, want := range []string{"rate_limit.device_rps=100", "rate_limit.ip_burst=10", "10.0.0.0/8"} {
		if !strings.Contains(buf.String(), want) {
			t.Errorf("log %q lacks %q", buf.String(), want)
		}
	}
}
