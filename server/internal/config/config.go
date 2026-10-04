// Package config loads obsync's settings: built-in defaults, then an
// optional YAML file, then OBSYNC_* environment variables, then validation.
package config

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"time"

	"gopkg.in/yaml.v3"
)

const (
	maxDays  = 36500 // 100 years
	maxHours = 8760  // 1 year
)

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
		add("cluster mode is not available yet")
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
	return errors.Join(errs...)
}

func (c Config) GCGrace() time.Duration { return time.Duration(c.GCGraceHours) * time.Hour }

func (c Config) JobsInterval() time.Duration {
	return time.Duration(c.JobsIntervalMinutes) * time.Minute
}
