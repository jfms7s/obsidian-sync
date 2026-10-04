// Package api exposes obsync over HTTP. Handlers only decode, call a
// service or the store, and encode; rules live in the services.
package api

import (
	"bufio"
	"context"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/jfms7s/obsidian-sync/server/internal/apperr"
	"github.com/jfms7s/obsidian-sync/server/internal/auth"
	obsyncv1 "github.com/jfms7s/obsidian-sync/server/internal/gen/obsync/v1"
	"github.com/jfms7s/obsidian-sync/server/internal/store"
	"github.com/jfms7s/obsidian-sync/server/internal/syncsvc"
)

type Store interface {
	ListDevices(ctx context.Context, userID string) ([]store.Device, error)
	RevokeDevice(ctx context.Context, userID, deviceID string) error
	KeyBundle(ctx context.Context, userID string) (store.KeyBundle, error)
	PutKeyBundle(ctx context.Context, userID string, kb store.KeyBundle) error
	CreateVault(ctx context.Context, v store.Vault, keys []store.VaultKey) error
	ListVaults(ctx context.Context, userID string) ([]store.Vault, error)
	VaultForMember(ctx context.Context, vaultID, userID string) (store.Vault, error)
	VaultKeys(ctx context.Context, vaultID, userID string) ([]store.VaultKey, error)
}

type Deps struct {
	Auth  *auth.Service
	Sync  *syncsvc.Service
	Store Store
	Hub   http.Handler
	Ready func(ctx context.Context) error
	Log   *slog.Logger
	// RateLimits bounds request rates; the zero value disables limiting.
	// Health checks are never limited.
	RateLimits RateLimits
}

type handlers struct {
	auth   *auth.Service
	sync   *syncsvc.Service
	store  Store
	ready  func(ctx context.Context) error
	log    *slog.Logger
	limits *limiters

	readyCache readyCache
}

func NewHandler(d Deps) http.Handler {
	h := &handlers{auth: d.Auth, sync: d.Sync, store: d.Store, ready: d.Ready, log: d.Log, limits: newLimiters(d.RateLimits)}
	if h.ready == nil {
		h.ready = func(context.Context) error { return nil }
	}
	if h.log == nil {
		h.log = slog.Default()
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", h.healthz)
	mux.HandleFunc("GET /readyz", h.readyz)
	mux.Handle("POST /v1/auth/login", h.ipLimited(http.HandlerFunc(h.login)))
	mux.HandleFunc("POST /v1/auth/logout", h.authed(h.logout))
	mux.HandleFunc("GET /v1/devices", h.authed(h.listDevices))
	mux.HandleFunc("DELETE /v1/devices/{device}", h.authed(h.revokeDevice))
	mux.HandleFunc("GET /v1/keys", h.authed(h.getKeys))
	mux.HandleFunc("PUT /v1/keys", h.authed(h.putKeys))
	h.registerVaultRoutes(mux)
	if d.Hub != nil {
		// The socket authenticates in its first frame, so the upgrade is
		// limited per address; frames after that are paced by the hub.
		mux.Handle("GET /v1/ws", h.ipLimited(d.Hub))
	}
	return h.recoverer(h.protoFallback(mux))
}

// protoFallback answers requests that match no route (404) or match a path
// with another method (405) with a protobuf Error instead of the mux's plain
// text, keeping the mux's Allow header.
func (h *handlers) protoFallback(mux *http.ServeMux) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fallback, pattern := mux.Handler(r)
		if pattern != "" {
			mux.ServeHTTP(w, r)
			return
		}
		// Run the mux's own fallback to learn its status and headers
		// (such as Allow), discarding its plain-text body.
		probe := &statusProbe{header: w.Header()}
		fallback.ServeHTTP(probe, r)
		switch probe.status {
		case http.StatusMethodNotAllowed:
			writeProto(w, http.StatusMethodNotAllowed, &obsyncv1.Error{
				Code: apperr.Invalid, Message: "method " + r.Method + " is not allowed here",
			})
		case http.StatusNotFound, 0:
			h.writeError(w, r, apperr.New(apperr.NotFound, "no such endpoint"))
		default:
			// Not expected from ServeMux; pass the status through.
			w.WriteHeader(probe.status)
		}
	})
}

type statusProbe struct {
	header http.Header
	status int
}

func (p *statusProbe) Header() http.Header { return p.header }
func (p *statusProbe) Write(b []byte) (int, error) {
	if p.status == 0 {
		p.status = http.StatusOK
	}
	return len(b), nil
}
func (p *statusProbe) WriteHeader(status int) {
	if p.status == 0 {
		p.status = status
	}
}

type authedHandler func(w http.ResponseWriter, r *http.Request, sess auth.Session)

// authed authenticates the bearer token, then spends one of the device's
// requests before next runs.
//
// A request with a missing, unknown or revoked token spends from a
// per-address budget instead, and once that is used up gets 429 rather than
// 401. A well-formed token is always looked up first (one indexed query), so
// valid tokens never touch that budget and are never blocked by it: behind a
// shared proxy or NAT, a stranger sending junk tokens must not stop everyone's
// sync. A token that cannot have been issued (see auth.WellFormedToken) is
// refused without a lookup, but answered and counted the same way. Tokens are
// 256 random bits, so answering a guess reveals nothing useful.
func (h *handlers) authed(next authedHandler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		scheme, token, _ := strings.Cut(strings.TrimSpace(r.Header.Get("Authorization")), " ")
		token = strings.TrimSpace(token)
		if !strings.EqualFold(scheme, "Bearer") || token == "" {
			h.authFailed(w, r, auth.ErrUnauthorized)
			return
		}
		sess, err := h.auth.Authenticate(r.Context(), token)
		if err != nil {
			h.authFailed(w, r, err)
			return
		}
		if h.limits.device != nil {
			if ok, retry := h.limits.device.Take(sess.DeviceID); !ok {
				writeRateLimited(w, retry)
				return
			}
		}
		next(w, r, sess)
	}
}

// authFailed answers a failed bearer authentication. Token failures spend
// from the client address's bad-token budget, answered with 429 once it is
// exhausted; other errors (such as a store failure) pass through.
func (h *handlers) authFailed(w http.ResponseWriter, r *http.Request, err error) {
	if h.limits.authFail != nil {
		switch apperr.CodeOf(err) {
		case apperr.Unauthorized, apperr.DeviceRevoked:
			if ok, retry := h.takeIP(h.limits.authFail, r); !ok {
				writeRateLimited(w, retry)
				return
			}
		}
	}
	h.writeError(w, r, err)
}

// recoverer turns a handler panic into an INTERNAL error, unless the handler
// already started its response, in which case the connection is aborted so
// the client sees a truncated reply instead of two responses glued together.
func (h *handlers) recoverer(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		tw := &trackingWriter{ResponseWriter: w, log: h.log}
		defer func() {
			if rec := recover(); rec != nil {
				if rec == http.ErrAbortHandler {
					panic(rec)
				}
				h.log.Error("handler panic", "method", r.Method, "path", r.URL.Path, "panic", fmt.Sprint(rec))
				if tw.wrote || tw.hijacked {
					// Too late for an error response; abort the connection
					// so the client cannot take the partial reply as whole.
					panic(http.ErrAbortHandler)
				}
				h.writeError(tw, r, apperr.New(apperr.Internal, "internal error"))
			}
		}()
		next.ServeHTTP(tw, r)
	})
}

// trackingWriter records whether the response has started. It also carries
// the logger so writeProto can report encoding failures.
type trackingWriter struct {
	http.ResponseWriter
	log      *slog.Logger
	wrote    bool
	hijacked bool
}

func (t *trackingWriter) WriteHeader(status int) {
	t.wrote = true
	t.ResponseWriter.WriteHeader(status)
}

func (t *trackingWriter) Write(b []byte) (int, error) {
	t.wrote = true
	return t.ResponseWriter.Write(b)
}

// Unwrap lets http.ResponseController reach the underlying writer.
func (t *trackingWriter) Unwrap() http.ResponseWriter { return t.ResponseWriter }

func (t *trackingWriter) Flush() {
	t.wrote = true
	if f, ok := t.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

// Hijack is needed by the WebSocket hub.
func (t *trackingWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	hj, ok := t.ResponseWriter.(http.Hijacker)
	if !ok {
		return nil, nil, fmt.Errorf("response writer does not support hijacking")
	}
	conn, rw, err := hj.Hijack()
	if err == nil {
		t.hijacked = true
	}
	return conn, rw, err
}

func (h *handlers) healthz(w http.ResponseWriter, _ *http.Request) {
	_, _ = w.Write([]byte("ok"))
}

// /readyz is unauthenticated and unlimited, so its result is reused for
// readyCacheTTL rather than pinging the database and blob store per request.
var (
	readyCacheTTL = time.Second
	readyNow      = time.Now
)

// readyCache holds the last readiness result. The mutex is held across the
// check, so concurrent callers in a window wait for and share one result.
type readyCache struct {
	mu      sync.Mutex
	checked time.Time
	err     error
	valid   bool
}

func (c *readyCache) check(ctx context.Context, ready func(context.Context) error) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	now := readyNow()
	if c.valid && now.Sub(c.checked) < readyCacheTTL && !now.Before(c.checked) {
		return c.err
	}
	err := ready(ctx)
	// A check cut short by this caller going away says nothing about the
	// server, so it is not cached for others.
	if ctx.Err() == nil {
		c.checked, c.err, c.valid = now, err, true
	}
	return err
}

func (h *handlers) readyz(w http.ResponseWriter, r *http.Request) {
	if err := h.readyCache.check(r.Context(), h.ready); err != nil {
		h.log.Warn("not ready", "err", err)
		http.Error(w, "not ready", http.StatusServiceUnavailable)
		return
	}
	_, _ = w.Write([]byte("ok"))
}
