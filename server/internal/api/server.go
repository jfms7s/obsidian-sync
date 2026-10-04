// Package api exposes obsync over HTTP. Handlers only decode, call a
// service or the store, and encode; rules live in the services.
package api

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"strings"

	"github.com/jfms7s/obsidian-sync/server/internal/apperr"
	"github.com/jfms7s/obsidian-sync/server/internal/auth"
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
}

type handlers struct {
	auth  *auth.Service
	sync  *syncsvc.Service
	store Store
	ready func(ctx context.Context) error
	log   *slog.Logger
}

func NewHandler(d Deps) http.Handler {
	h := &handlers{auth: d.Auth, sync: d.Sync, store: d.Store, ready: d.Ready, log: d.Log}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", h.healthz)
	mux.HandleFunc("GET /readyz", h.readyz)
	mux.HandleFunc("POST /v1/auth/login", h.login)
	mux.HandleFunc("POST /v1/auth/logout", h.authed(h.logout))
	mux.HandleFunc("GET /v1/devices", h.authed(h.listDevices))
	mux.HandleFunc("DELETE /v1/devices/{device}", h.authed(h.revokeDevice))
	mux.HandleFunc("GET /v1/keys", h.authed(h.getKeys))
	mux.HandleFunc("PUT /v1/keys", h.authed(h.putKeys))
	if d.Hub != nil {
		mux.Handle("GET /v1/ws", d.Hub)
	}
	return h.recoverer(mux)
}

type authedHandler func(w http.ResponseWriter, r *http.Request, sess auth.Session)

func (h *handlers) authed(next authedHandler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		token, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
		if !ok {
			h.writeError(w, r, auth.ErrUnauthorized)
			return
		}
		sess, err := h.auth.Authenticate(r.Context(), token)
		if err != nil {
			h.writeError(w, r, err)
			return
		}
		next(w, r, sess)
	}
}

func (h *handlers) recoverer(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if rec := recover(); rec != nil {
				if rec == http.ErrAbortHandler {
					panic(rec)
				}
				h.log.Error("handler panic", "method", r.Method, "path", r.URL.Path, "panic", fmt.Sprint(rec))
				h.writeError(w, r, apperr.New(apperr.Internal, "internal error"))
			}
		}()
		next.ServeHTTP(w, r)
	})
}

func (h *handlers) healthz(w http.ResponseWriter, _ *http.Request) {
	_, _ = w.Write([]byte("ok"))
}

func (h *handlers) readyz(w http.ResponseWriter, r *http.Request) {
	if err := h.ready(r.Context()); err != nil {
		h.log.Warn("not ready", "err", err)
		http.Error(w, "not ready", http.StatusServiceUnavailable)
		return
	}
	_, _ = w.Write([]byte("ok"))
}
