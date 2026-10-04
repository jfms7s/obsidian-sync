// Package hub pushes "vault X reached seq N" to connected devices over
// WebSockets so they pull changes within seconds.
package hub

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/coder/websocket"
	"google.golang.org/protobuf/proto"

	"github.com/jfms7s/obsidian-sync/server/internal/apperr"
	"github.com/jfms7s/obsidian-sync/server/internal/auth"
	"github.com/jfms7s/obsidian-sync/server/internal/bus"
	obsyncv1 "github.com/jfms7s/obsidian-sync/server/internal/gen/obsync/v1"
	"github.com/jfms7s/obsidian-sync/server/internal/ids"
	"github.com/jfms7s/obsidian-sync/server/internal/store"
)

const (
	maxSubscriptions = 100
	maxFrameBytes    = 64 << 10
)

type Authenticator interface {
	Authenticate(ctx context.Context, token string) (auth.Session, error)
}

type Vaults interface {
	VaultForMember(ctx context.Context, vaultID, userID string) (store.Vault, error)
}

type Options struct {
	AuthTimeout  time.Duration
	WriteTimeout time.Duration
}

type Hub struct {
	auth   Authenticator
	vaults Vaults
	bus    bus.Bus
	log    *slog.Logger
	opts   Options
}

func New(a Authenticator, v Vaults, b bus.Bus, log *slog.Logger, opts Options) *Hub {
	if opts.AuthTimeout == 0 {
		opts.AuthTimeout = 10 * time.Second
	}
	if opts.WriteTimeout == 0 {
		opts.WriteTimeout = 10 * time.Second
	}
	return &Hub{auth: a, vaults: v, bus: b, log: log, opts: opts}
}

func (h *Hub) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		// The Origin header is not checked: the socket is authenticated by a
		// token in its first frame, never by cookies, so a cross-origin page
		// gains nothing. Obsidian connects from app://obsidian.md and
		// capacitor://localhost.
		InsecureSkipVerify: true,
	})
	if err != nil {
		return // Accept has already written the HTTP error
	}
	defer ws.CloseNow()
	ws.SetReadLimit(maxFrameBytes)

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	c := &conn{hub: h, ws: ws, ctx: ctx, subs: map[string]func(){}}
	defer c.unsubscribeAll()
	if err := c.run(); err != nil {
		h.log.Debug("websocket closed", "err", err)
	}
}

type conn struct {
	hub   *Hub
	ws    *websocket.Conn
	ctx   context.Context
	token string
	sess  auth.Session

	mu   sync.Mutex
	subs map[string]func() // vault id → bus cancel
}

func (c *conn) run() error {
	if err := c.authenticate(); err != nil {
		return err
	}
	for {
		var f obsyncv1.ClientFrame
		if err := c.read(c.ctx, &f); err != nil {
			return err
		}
		switch m := f.Frame.(type) {
		case *obsyncv1.ClientFrame_Subscribe:
			c.subscribe(m.Subscribe.GetVaultIds())
		case *obsyncv1.ClientFrame_Ping:
			if _, err := c.hub.auth.Authenticate(c.ctx, c.token); err != nil {
				return c.fail(err)
			}
			pong := &obsyncv1.ServerFrame{Frame: &obsyncv1.ServerFrame_Pong{Pong: &obsyncv1.Pong{Nonce: m.Ping.GetNonce()}}}
			if err := c.send(pong); err != nil {
				return err
			}
		default:
			return c.fail(apperr.New(apperr.Invalid, "unexpected frame"))
		}
	}
}

func (c *conn) authenticate() error {
	ctx, cancel := context.WithTimeout(c.ctx, c.hub.opts.AuthTimeout)
	defer cancel()
	var f obsyncv1.ClientFrame
	if err := c.read(ctx, &f); err != nil {
		return err // a cancelled Read closes the socket
	}
	a := f.GetAuth()
	if a == nil {
		return c.fail(apperr.New(apperr.Unauthorized, "the first frame must be auth"))
	}
	sess, err := c.hub.auth.Authenticate(c.ctx, a.GetToken())
	if err != nil {
		return c.fail(err)
	}
	c.token, c.sess = a.GetToken(), sess
	return c.send(&obsyncv1.ServerFrame{Frame: &obsyncv1.ServerFrame_AuthOk{AuthOk: &obsyncv1.AuthOk{DeviceId: sess.DeviceID}}})
}

func (c *conn) read(ctx context.Context, f *obsyncv1.ClientFrame) error {
	typ, data, err := c.ws.Read(ctx)
	if err != nil {
		return err
	}
	if typ != websocket.MessageBinary {
		return c.fail(apperr.New(apperr.Invalid, "frames must be binary"))
	}
	if err := proto.Unmarshal(data, f); err != nil {
		return c.fail(apperr.New(apperr.Invalid, "malformed frame"))
	}
	return nil
}

// subscribe replaces the connection's subscriptions with vaultIDs.
func (c *conn) subscribe(vaultIDs []string) {
	c.unsubscribeAll()
	if len(vaultIDs) > maxSubscriptions {
		c.sendError(apperr.New(apperr.Invalid, "subscribe to at most %d vaults", maxSubscriptions))
		return
	}
	seen := make(map[string]struct{}, len(vaultIDs))
	for _, id := range vaultIDs {
		// A repeated ID would otherwise replace c.subs[id] and leak the first
		// bus subscription and its forward goroutine.
		if _, dup := seen[id]; dup {
			continue
		}
		seen[id] = struct{}{}
		if !ids.Valid(id) {
			c.sendError(apperr.New(apperr.NotFound, "vault %q not found", id))
			continue
		}
		// Subscribe before reading the seq, so a commit landing in between is
		// delivered rather than missed.
		ch, cancel := c.hub.bus.Subscribe(id)
		v, err := c.hub.vaults.VaultForMember(c.ctx, id, c.sess.UserID)
		if err != nil {
			cancel()
			if errors.Is(err, store.ErrNotFound) {
				c.sendError(apperr.New(apperr.NotFound, "vault %s not found", id))
			} else {
				c.hub.log.Error("subscribe", "vault", id, "err", err)
				c.sendError(apperr.New(apperr.Internal, "internal error"))
			}
			continue
		}
		c.mu.Lock()
		if old, ok := c.subs[id]; ok {
			old() // defensive: never drop a live subscription's cancel
		}
		c.subs[id] = cancel
		c.mu.Unlock()
		go c.forward(id, v.Seq, ch)
	}
}

func (c *conn) forward(vaultID string, seq int64, ch <-chan bus.Notify) {
	if err := c.sendNotify(vaultID, seq); err != nil {
		return
	}
	for n := range ch {
		if err := c.sendNotify(n.VaultID, n.Seq); err != nil {
			return
		}
	}
}

func (c *conn) unsubscribeAll() {
	c.mu.Lock()
	defer c.mu.Unlock()
	for id, cancel := range c.subs {
		cancel()
		delete(c.subs, id)
	}
}

func (c *conn) sendNotify(vaultID string, seq int64) error {
	return c.send(&obsyncv1.ServerFrame{Frame: &obsyncv1.ServerFrame_Notify{Notify: &obsyncv1.Notify{VaultId: vaultID, Seq: uint64(seq)}}})
}

func (c *conn) sendError(e *apperr.Error) {
	_ = c.send(&obsyncv1.ServerFrame{Frame: &obsyncv1.ServerFrame_Error{Error: &obsyncv1.Error{Code: e.Code, Message: e.Msg}}})
}

// fail reports err to the client as an Error frame and closes the socket.
func (c *conn) fail(err error) error {
	var ae *apperr.Error
	if !errors.As(err, &ae) {
		c.hub.log.Error("websocket", "err", err)
		ae = apperr.New(apperr.Internal, "internal error")
	}
	c.sendError(ae)
	_ = c.ws.Close(websocket.StatusPolicyViolation, ae.Msg)
	return err
}

// send writes one frame. websocket.Conn allows concurrent writers.
func (c *conn) send(f *obsyncv1.ServerFrame) error {
	data, err := proto.Marshal(f)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(c.ctx, c.hub.opts.WriteTimeout)
	defer cancel()
	return c.ws.Write(ctx, websocket.MessageBinary, data)
}
