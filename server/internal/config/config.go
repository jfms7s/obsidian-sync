// Package config loads obsync's settings: built-in defaults, then an
// optional YAML file, then OBSYNC_* environment variables, then validation.
package config

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/netip"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"gopkg.in/yaml.v3"
)

const (
	maxDays  = 36500 // 100 years
	maxHours = 8760  // 1 year

	// Rate limit bounds: anything outside them is a typo, not a policy.
	minRPS   = 0.001 // one request per ~17 minutes
	maxRPS   = 100000
	maxBurst = 1000000
)

// RateLimit bounds request rates with token buckets. A zero rate disables
// that limiter.
type RateLimit struct {
	// DeviceRPS and DeviceBurst limit each authenticated device across all
	// its HTTP requests (chunk transfers and commits included).
	DeviceRPS   float64 `yaml:"device_rps"`
	DeviceBurst int     `yaml:"device_burst"`
	// IPRPS and IPBurst limit each client address on unauthenticated
	// requests (login, WebSocket upgrades) and, separately, on requests whose
	// bearer token is missing or invalid.
	IPRPS   float64 `yaml:"ip_rps"`
	IPBurst int     `yaml:"ip_burst"`
}

// Retention bounds history and trash. A version that is not its file's head
// is deleted as soon as either history limit is exceeded. Heads are never
// pruned, and a deleted file's last content version stays restorable until
// its trash period ends.
type Retention struct {
	// HistoryDays keeps a replaced version this many days after the edit or
	// deletion that replaced it. 0 = no age limit.
	HistoryDays int `yaml:"history_days"`
	// HistoryMaxVersions keeps at most this many versions per file,
	// including the head but not a deletion tombstone. 0 = no count limit.
	// With both limits 0, history is never pruned.
	HistoryMaxVersions int `yaml:"history_max_versions"`
	// TrashDays is how long a deleted file stays restorable. At least 1.
	TrashDays int `yaml:"trash_days"`
}

type Config struct {
	Listen              string    `yaml:"listen"`
	DataDir             string    `yaml:"data_dir"`
	DatabaseURL         string    `yaml:"database_url"`
	DatabaseAuthToken   string    `yaml:"database_auth_token"`
	BlobBackend         string    `yaml:"blob_backend"`
	BlobFSDir           string    `yaml:"blob_fs_dir"`
	Cluster             bool      `yaml:"cluster"`
	DefaultQuotaBytes   int64     `yaml:"default_quota_bytes"`
	MaxFileSizeBytes    int64     `yaml:"max_file_size_bytes"`
	Retention           Retention `yaml:"retention"`
	GCGraceHours        int       `yaml:"gc_grace_hours"`
	JobsIntervalMinutes int       `yaml:"jobs_interval_minutes"`
	LogLevel            string    `yaml:"log_level"`
	RateLimit           RateLimit `yaml:"rate_limit"`
	// TrustedProxies lists the reverse proxies (CIDRs, or single addresses)
	// whose X-Forwarded-For header is believed. Empty: the TCP peer is
	// always the client, so behind a proxy every client shares one address.
	TrustedProxies []string `yaml:"trusted_proxies"`
}

func Defaults() Config {
	return Config{
		Listen:              ":8080",
		DataDir:             "/data",
		BlobBackend:         "fs",
		DefaultQuotaBytes:   10 << 30,
		MaxFileSizeBytes:    2 << 30,
		Retention:           Retention{HistoryDays: 30, TrashDays: 30},
		GCGraceHours:        24,
		JobsIntervalMinutes: 60,
		LogLevel:            "info",
		// A device's own requests: an initial sync of a few thousand small
		// files is about one chunk upload per file plus batched exists and
		// commit calls, sent a few at a time. The burst absorbs a vault of
		// ~1000 files outright, and 100/s is about what a client with a few
		// requests in flight reaches over a WAN anyway, so a large first
		// sync is at most paced, while a runaway client is still capped.
		// Unauthenticated traffic per address: logins and WebSocket
		// (re)connects are rare, so 1/s with a burst of 10 covers a
		// household of devices reconnecting together.
		RateLimit: RateLimit{DeviceRPS: 100, DeviceBurst: 1000, IPRPS: 1, IPBurst: 10},
	}
}

// Load builds the effective configuration. path may be empty (no file).
func Load(path string, getenv func(string) string) (Config, error) {
	cfg := Defaults()
	if path != "" {
		data, err := os.ReadFile(path)
		if err != nil {
			return Config{}, fmt.Errorf("read config file: %w", err)
		}
		dec := yaml.NewDecoder(bytes.NewReader(data))
		dec.KnownFields(true)
		if err := dec.Decode(&cfg); err != nil && !errors.Is(err, io.EOF) {
			return Config{}, fmt.Errorf("parse config file %s: %w", path, err)
		}
		// A second document would be silently ignored; reject it so an
		// operator never edits settings that have no effect.
		var extra yaml.Node
		if err := dec.Decode(&extra); !errors.Is(err, io.EOF) {
			return Config{}, fmt.Errorf("parse config file %s: config file must contain a single YAML document", path)
		}
	}
	if err := applyEnv(&cfg, getenv); err != nil {
		return Config{}, err
	}
	cfg.fillDerived()
	if err := cfg.Validate(); err != nil {
		return Config{}, err
	}
	return cfg, nil
}

func applyEnv(c *Config, getenv func(string) string) error {
	var errs []error
	str := func(name string, dst *string) {
		if v := getenv(name); v != "" {
			*dst = v
		}
	}
	integer := func(name string, dst *int) {
		if v := getenv(name); v != "" {
			n, err := strconv.Atoi(v)
			if err != nil {
				errs = append(errs, fmt.Errorf("%s: %q is not an integer", name, v))
				return
			}
			*dst = n
		}
	}
	integer64 := func(name string, dst *int64) {
		if v := getenv(name); v != "" {
			n, err := strconv.ParseInt(v, 10, 64)
			if err != nil {
				errs = append(errs, fmt.Errorf("%s: %q is not an integer", name, v))
				return
			}
			*dst = n
		}
	}
	float := func(name string, dst *float64) {
		if v := getenv(name); v != "" {
			f, err := strconv.ParseFloat(v, 64)
			if err != nil {
				errs = append(errs, fmt.Errorf("%s: %q is not a number", name, v))
				return
			}
			*dst = f
		}
	}
	list := func(name string, dst *[]string) {
		if v := getenv(name); v != "" {
			var out []string
			for _, item := range strings.Split(v, ",") {
				if item = strings.TrimSpace(item); item != "" {
					out = append(out, item)
				}
			}
			*dst = out
		}
	}
	boolean := func(name string, dst *bool) {
		if v := getenv(name); v != "" {
			b, err := strconv.ParseBool(v)
			if err != nil {
				errs = append(errs, fmt.Errorf("%s: %q is not a boolean", name, v))
				return
			}
			*dst = b
		}
	}

	str("OBSYNC_LISTEN", &c.Listen)
	str("OBSYNC_DATA_DIR", &c.DataDir)
	str("OBSYNC_DATABASE_URL", &c.DatabaseURL)
	str("OBSYNC_DATABASE_AUTH_TOKEN", &c.DatabaseAuthToken)
	str("OBSYNC_BLOB_BACKEND", &c.BlobBackend)
	str("OBSYNC_BLOB_FS_DIR", &c.BlobFSDir)
	boolean("OBSYNC_CLUSTER", &c.Cluster)
	integer64("OBSYNC_DEFAULT_QUOTA_BYTES", &c.DefaultQuotaBytes)
	integer64("OBSYNC_MAX_FILE_SIZE_BYTES", &c.MaxFileSizeBytes)
	integer("OBSYNC_HISTORY_DAYS", &c.Retention.HistoryDays)
	integer("OBSYNC_HISTORY_MAX_VERSIONS", &c.Retention.HistoryMaxVersions)
	integer("OBSYNC_TRASH_DAYS", &c.Retention.TrashDays)
	integer("OBSYNC_GC_GRACE_HOURS", &c.GCGraceHours)
	integer("OBSYNC_JOBS_INTERVAL_MINUTES", &c.JobsIntervalMinutes)
	str("OBSYNC_LOG_LEVEL", &c.LogLevel)
	float("OBSYNC_RATE_LIMIT_DEVICE_RPS", &c.RateLimit.DeviceRPS)
	integer("OBSYNC_RATE_LIMIT_DEVICE_BURST", &c.RateLimit.DeviceBurst)
	float("OBSYNC_RATE_LIMIT_IP_RPS", &c.RateLimit.IPRPS)
	integer("OBSYNC_RATE_LIMIT_IP_BURST", &c.RateLimit.IPBurst)
	list("OBSYNC_TRUSTED_PROXIES", &c.TrustedProxies)
	return errors.Join(errs...)
}

func (c *Config) fillDerived() {
	if c.DatabaseURL == "" {
		c.DatabaseURL = "file:" + filepath.Join(c.DataDir, "meta.db")
	}
	if c.BlobFSDir == "" {
		c.BlobFSDir = filepath.Join(c.DataDir, "blobs")
	}
}

// Validate reports every problem at once so an operator fixes them in one go.
func (c Config) Validate() error {
	var errs []error
	add := func(format string, args ...any) { errs = append(errs, fmt.Errorf(format, args...)) }

	if c.Listen == "" {
		add("listen must not be empty")
	}
	if c.DataDir == "" {
		add("data_dir must not be empty")
	}
	// Only the scheme is ever echoed: the URL may carry credentials.
	if u, err := url.Parse(c.DatabaseURL); err != nil {
		add("database_url is not a valid URL")
	} else {
		switch u.Scheme {
		case "file", "libsql", "http", "https":
		default:
			add("database_url scheme %q is not supported (use file:, libsql://, http:// or https://)", u.Scheme)
		}
	}
	switch c.BlobBackend {
	case "fs":
	case "s3":
		add(`blob_backend "s3" is not available yet; it arrives with clustered mode`)
	default:
		add("blob_backend %q is not supported (use \"fs\")", c.BlobBackend)
	}
	if c.Cluster {
		if c.BlobBackend == "s3" {
			add("cluster mode is not available yet")
		} else {
			// The fs backend and its temp sweep assume one node owns data_dir.
			add(`cluster mode is not available yet; when it arrives it requires blob_backend "s3" (the fs backend is single-node only)`)
		}
	}
	if c.DefaultQuotaBytes <= 0 {
		add("default_quota_bytes must be positive")
	}
	if c.MaxFileSizeBytes <= 0 {
		add("max_file_size_bytes must be positive")
	}
	if c.Retention.HistoryDays < 0 || c.Retention.HistoryMaxVersions < 0 {
		add("retention history values must not be negative")
	}
	if c.Retention.TrashDays < 1 {
		add("retention trash_days must be at least 1")
	}
	// Upper bounds keep the day/hour/minute counts far below the point where
	// converting them to a time.Duration overflows (about 106,751 days). An
	// overflowed retention cutoff lands in the future and prunes everything.
	if c.Retention.HistoryDays > maxDays || c.Retention.TrashDays > maxDays {
		add(fmt.Sprintf("retention days must be at most %d", maxDays))
	}
	if c.GCGraceHours < 1 || c.GCGraceHours > maxHours {
		add(fmt.Sprintf("gc_grace_hours must be between 1 and %d", maxHours))
	}
	if c.JobsIntervalMinutes < 1 || c.JobsIntervalMinutes > maxHours*60 {
		add(fmt.Sprintf("jobs_interval_minutes must be between 1 and %d", maxHours*60))
	}
	switch c.LogLevel {
	case "debug", "info", "warn", "error":
	default:
		add("log_level %q is not one of debug, info, warn, error", c.LogLevel)
	}
	validateLimit := func(name string, rps float64, burst int) {
		// !(rps >= 0) also catches NaN.
		if !(rps == 0 || (rps >= minRPS && rps <= maxRPS)) {
			add("rate_limit.%s_rps must be 0 (disabled) or between %g and %g", name, minRPS, float64(maxRPS))
		}
		if rps != 0 && (burst < 1 || burst > maxBurst) {
			add("rate_limit.%s_burst must be between 1 and %d", name, maxBurst)
		} else if burst < 0 {
			add("rate_limit.%s_burst must not be negative", name)
		}
	}
	validateLimit("device", c.RateLimit.DeviceRPS, c.RateLimit.DeviceBurst)
	validateLimit("ip", c.RateLimit.IPRPS, c.RateLimit.IPBurst)
	for _, p := range c.TrustedProxies {
		if _, err := parseProxy(p); err != nil {
			add("trusted_proxies: %q is not a CIDR or IP address", p)
		}
	}
	return errors.Join(errs...)
}

// parseProxy parses a trusted proxy entry: a CIDR, or one address taken as a
// single-host prefix. The result is masked.
func parseProxy(s string) (netip.Prefix, error) {
	if p, err := netip.ParsePrefix(s); err == nil {
		return p.Masked(), nil
	}
	a, err := netip.ParseAddr(s)
	if err != nil {
		return netip.Prefix{}, err
	}
	a = a.Unmap()
	return netip.PrefixFrom(a, a.BitLen()), nil
}

// TrustedProxyPrefixes returns TrustedProxies parsed. Entries that do not
// parse are skipped; Validate rejects them.
func (c Config) TrustedProxyPrefixes() []netip.Prefix {
	var out []netip.Prefix
	for _, s := range c.TrustedProxies {
		if p, err := parseProxy(s); err == nil {
			out = append(out, p)
		}
	}
	return out
}

const redacted = "REDACTED"

// LogValue lets a Config be logged without leaking credentials: the auth
// token is replaced, and so are the database URL's userinfo password,
// fragment and credential-like query parameters.
func (c Config) LogValue() slog.Value {
	token := ""
	if c.DatabaseAuthToken != "" {
		token = redacted
	}
	return slog.GroupValue(
		slog.String("listen", c.Listen),
		slog.String("data_dir", c.DataDir),
		slog.String("database_url", redactURL(c.DatabaseURL)),
		slog.String("database_auth_token", token),
		slog.String("blob_backend", c.BlobBackend),
		slog.String("blob_fs_dir", c.BlobFSDir),
		slog.Bool("cluster", c.Cluster),
		slog.Int64("default_quota_bytes", c.DefaultQuotaBytes),
		slog.Int64("max_file_size_bytes", c.MaxFileSizeBytes),
		slog.Group("retention",
			slog.Int("history_days", c.Retention.HistoryDays),
			slog.Int("history_max_versions", c.Retention.HistoryMaxVersions),
			slog.Int("trash_days", c.Retention.TrashDays),
		),
		slog.Int("gc_grace_hours", c.GCGraceHours),
		slog.Int("jobs_interval_minutes", c.JobsIntervalMinutes),
		slog.String("log_level", c.LogLevel),
		slog.Group("rate_limit",
			slog.Float64("device_rps", c.RateLimit.DeviceRPS),
			slog.Int("device_burst", c.RateLimit.DeviceBurst),
			slog.Float64("ip_rps", c.RateLimit.IPRPS),
			slog.Int("ip_burst", c.RateLimit.IPBurst),
		),
		slog.String("trusted_proxies", strings.Join(c.TrustedProxies, ",")),
	)
}

// redactURL hides the userinfo, drops the fragment (it can carry a token, as
// in "#authToken=...") and hides any query parameter whose name looks like a
// credential. A URL that does not parse is hidden entirely, since its parts
// cannot be told apart.
func redactURL(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		return redacted
	}
	if u.User != nil {
		u.User = url.User(redacted)
	}
	u.Fragment, u.RawFragment = "", ""
	if u.RawQuery != "" {
		q, err := url.ParseQuery(u.RawQuery)
		if err != nil {
			u.RawQuery = redacted
		} else {
			for k := range q {
				if isCredentialKey(k) {
					q[k] = []string{redacted}
				}
			}
			u.RawQuery = q.Encode()
		}
	}
	return u.String()
}

// isCredentialKey reports whether a query parameter name looks like it holds
// a credential: it contains "token", "secret", "password" or "key" (in any
// case), or is "jwt".
func isCredentialKey(k string) bool {
	k = strings.ToLower(k)
	if k == "jwt" {
		return true
	}
	for _, s := range []string{"token", "secret", "password", "key"} {
		if strings.Contains(k, s) {
			return true
		}
	}
	return false
}

func (c Config) GCGrace() time.Duration { return time.Duration(c.GCGraceHours) * time.Hour }

func (c Config) JobsInterval() time.Duration {
	return time.Duration(c.JobsIntervalMinutes) * time.Minute
}
