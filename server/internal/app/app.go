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
	blobs, err := blob.NewFS(cfg.BlobFSDir)
	if err != nil {
		st.Close()
		return nil, err
	}
	authSvc, err := auth.NewService(st, auth.Options{Params: opts.PasswordParams})
	if err != nil {
		st.Close()
		return nil, err
	}
	b := bus.NewMemory()
	h := hub.New(authSvc, st, b, log, hub.Options{})
	syncSvc := syncsvc.New(st, blobs, b, syncsvc.Limits{MaxFileSizeBytes: cfg.MaxFileSizeBytes}, log)
	handler := api.NewHandler(api.Deps{
		Auth:  authSvc,
		Sync:  syncSvc,
		Store: st,
		Hub:   h,
		Ready: func(ctx context.Context) error { return errors.Join(st.Ping(ctx), blobs.Ping(ctx)) },
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
	st, err := store.Open(ctx, store.Options{URL: cfg.DatabaseURL, AuthToken: cfg.DatabaseAuthToken})
	if err != nil {
		return nil, err
	}
	if err := st.Migrate(ctx); err != nil {
		st.Close()
		return nil, fmt.Errorf("migrate database: %w", err)
	}
	return st, nil
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
