// Package app wires obsync's components together and runs the server.
package app

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/jfms7s/obsidian-sync/server/internal/api"
	"github.com/jfms7s/obsidian-sync/server/internal/auth"
	"github.com/jfms7s/obsidian-sync/server/internal/blob"
	"github.com/jfms7s/obsidian-sync/server/internal/bus"
	"github.com/jfms7s/obsidian-sync/server/internal/config"
	"github.com/jfms7s/obsidian-sync/server/internal/hub"
	"github.com/jfms7s/obsidian-sync/server/internal/jobs"
	"github.com/jfms7s/obsidian-sync/server/internal/store"
	"github.com/jfms7s/obsidian-sync/server/internal/syncsvc"
)

// shutdownTimeout fits inside the 10s grace period `docker stop` gives
// before it sends SIGKILL.
const shutdownTimeout = 10 * time.Second

// HTTP server timeouts. Request bodies get their own read deadlines in
// package api; WebSocket connections are hijacked and manage their own.
const (
	readHeaderTimeout = 10 * time.Second
	idleTimeout       = 120 * time.Second
)

type Options struct {
	PasswordParams auth.Params // zero = auth.DefaultParams
}

type App struct {
	Store   *store.Store
	Blobs   blob.Store
	Handler http.Handler
	Hub     *hub.Hub
	Jobs    *jobs.Runner

	log *slog.Logger
}

// Build opens and migrates the database and assembles the single-node server.
func Build(ctx context.Context, cfg config.Config, log *slog.Logger, opts Options) (*App, error) {
	if opts.PasswordParams == (auth.Params{}) {
		opts.PasswordParams = auth.DefaultParams
	}
	st, err := OpenStore(ctx, cfg)
	if err != nil {
		return nil, err
	}
	blobs, err := OpenBlobs(cfg)
	if err != nil {
		st.Close()
		return nil, err
	}
	b, err := OpenBus(cfg)
	if err != nil {
		st.Close()
		return nil, err
	}
	authSvc, err := auth.NewService(st, auth.Options{Params: opts.PasswordParams})
	if err != nil {
		st.Close()
		return nil, err
	}
	h := hub.New(authSvc, st, b, log, hub.Options{})
	syncSvc := syncsvc.New(st, blobs, b, syncsvc.Limits{MaxFileSizeBytes: cfg.MaxFileSizeBytes}, log)
	handler := api.NewHandler(api.Deps{
		Auth:  authSvc,
		Sync:  syncSvc,
		Store: st,
		Hub:   h,
		Ready: readiness(st, blobs, b),
		Log:   log,
		RateLimits: api.RateLimits{
			DeviceRPS:      cfg.RateLimit.DeviceRPS,
			DeviceBurst:    cfg.RateLimit.DeviceBurst,
			IPRPS:          cfg.RateLimit.IPRPS,
			IPBurst:        cfg.RateLimit.IPBurst,
			TrustedProxies: cfg.TrustedProxyPrefixes(),
		},
	})
	runner := jobs.New(st, blobs, jobs.Config{
		Interval:  cfg.JobsInterval(),
		Retention: cfg.Retention,
		GCGrace:   cfg.GCGrace(),
	}, time.Now, log)
	return &App{Store: st, Blobs: blobs, Handler: handler, Hub: h, Jobs: runner, log: log}, nil
}

// EnsureDatabaseDir creates the directory of a local (file:) database, mode
// 0700, so a fresh data dir works without manual setup. Remote URLs are left
// alone.
func EnsureDatabaseDir(databaseURL string) error {
	path, ok := strings.CutPrefix(databaseURL, "file:")
	if !ok {
		return nil
	}
	if i := strings.IndexByte(path, '?'); i >= 0 {
		path = path[:i]
	}
	if rest, ok := strings.CutPrefix(path, "//"); ok {
		path = rest // file:///abs/path → /abs/path
		if !strings.HasPrefix(path, "/") {
			path = "/" + path
		}
	}
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("create data dir %s: %w", dir, err)
	}
	return nil
}

// OpenStore creates a local database's directory if needed, then opens and
// migrates the database. Every command that touches the database uses it.
func OpenStore(ctx context.Context, cfg config.Config) (*store.Store, error) {
	if err := EnsureDatabaseDir(cfg.DatabaseURL); err != nil {
		return nil, err
	}
	st, err := store.Open(ctx, store.Options{
		URL:         cfg.DatabaseURL,
		AuthToken:   cfg.DatabaseAuthToken,
		Synchronous: store.Synchronous(cfg.DatabaseSynchronous),
	})
	if err != nil {
		return nil, err
	}
	if err := st.Migrate(ctx); err != nil {
		st.Close()
		return nil, fmt.Errorf("migrate database: %w", err)
	}
	return st, nil
}

// OpenBlobs builds the configured blob store. Every command that touches
// blobs uses it, so serve and admin always agree on where blobs live.
func OpenBlobs(cfg config.Config) (blob.Store, error) {
	switch cfg.BlobBackend {
	case "fs":
		return blob.NewFS(cfg.BlobFSDir)
	default:
		// config.Validate rejects it first.
		return nil, fmt.Errorf("blob backend %q is not supported", cfg.BlobBackend)
	}
}

// OpenBus builds the notification bus: in memory on a single node.
func OpenBus(cfg config.Config) (bus.Bus, error) {
	if cfg.Cluster {
		// config.Validate rejects it first.
		return nil, errors.New("cluster mode is not available yet: there is no shared bus")
	}
	return bus.NewMemory(), nil
}

// readiness checks every backend that can be checked: the ones with a Ping
// method. A backend without one (the in-memory bus) has nothing to fail.
func readiness(backends ...any) func(context.Context) error {
	var checks []func(context.Context) error
	for _, b := range backends {
		if p, ok := b.(interface{ Ping(context.Context) error }); ok {
			checks = append(checks, p.Ping)
		}
	}
	return func(ctx context.Context) error {
		errs := make([]error, 0, len(checks))
		for _, check := range checks {
			errs = append(errs, check(ctx))
		}
		return errors.Join(errs...)
	}
}

func (a *App) Close() error { return a.Store.Close() }

// Serve runs HTTP on ln and the maintenance jobs until ctx ends, then shuts
// down gracefully. If the listener fails first, Serve still shuts down the
// same way before returning that error.
func (a *App) Serve(ctx context.Context, ln net.Listener) error {
	baseCtx, cancelBase := context.WithCancel(context.Background())
	defer cancelBase()
	srv := &http.Server{
		Handler:           a.Handler,
		ReadHeaderTimeout: readHeaderTimeout,
		IdleTimeout:       idleTimeout,
		BaseContext:       func(net.Listener) context.Context { return baseCtx },
		ErrorLog:          slog.NewLogLogger(a.log.Handler(), slog.LevelWarn),
	}
	// Shutdown does not wait for hijacked WebSocket connections; cancelling
	// their request context makes the hub close them.
	srv.RegisterOnShutdown(cancelBase)

	jobsCtx, stopJobs := context.WithCancel(ctx)
	jobsDone := make(chan struct{})
	go func() { defer close(jobsDone); a.Jobs.Run(jobsCtx) }()
	// Jobs use the store, so Serve returns (and the caller may Close) only
	// after they have stopped. Their work is ctx-aware.
	defer func() { stopJobs(); <-jobsDone }()

	errCh := make(chan error, 1)
	go func() { errCh <- srv.Serve(ln) }()
	var serveErr error
	select {
	case err := <-errCh:
		if !errors.Is(err, http.ErrServerClosed) {
			serveErr = fmt.Errorf("serve: %w", err)
		}
	case <-ctx.Done():
	}
	shutdownCtx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
	defer cancel()
	err := srv.Shutdown(shutdownCtx)
	// Shutdown has cancelled the sockets' contexts but does not wait for
	// them; wait (bounded) so none outlives Serve and touches a closed store.
	hubDone := make(chan struct{})
	go func() { a.Hub.Wait(); close(hubDone) }()
	select {
	case <-hubDone:
	case <-shutdownCtx.Done():
		err = errors.Join(err, errors.New("websockets still open"))
	}
	if err != nil {
		err = fmt.Errorf("shutdown: %w", err)
	}
	return errors.Join(serveErr, err)
}
