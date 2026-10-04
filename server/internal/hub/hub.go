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
	// IdleTimeout closes an authenticated socket that sends no frame for
	// this long. Clients ping every 30s, so the default of 90s tolerates two
	// lost pings, and a revoked device that stops pinging is cut off.
	IdleTimeout time.Duration
	// MinSubscribeInterval is the least time allowed between two Subscribe
	// frames on one socket (default 1s). Each Subscribe runs a membership
	// query per vault, so a client re-subscribing in a tight loop would load
	// the store; a well-behaved client subscribes once per (re)connect and
	// when its vault list changes, so a faster one is closed.
	MinSubscribeInterval time.Duration
	// MembershipRecheckInterval is the least time between two membership
	// rechecks on one socket (default 15s). The recheck runs on Ping and costs
	// a query per subscribed vault; Pings are not rate limited, so without
	// this a client pinging in a loop would load the store.
	MembershipRecheckInterval time.Duration
}

type Hub struct {
	auth   Authenticator
	vaults Vaults
	bus    bus.Bus
	log    *slog.Logger
	opts   Options
	wg     sync.WaitGroup // connection and forward goroutines
}

func New(a Authenticator, v Vaults, b bus.Bus, log *slog.Logger, opts Options) *Hub {
	if opts.AuthTimeout == 0 {
		opts.AuthTimeout = 10 * time.Second
	}
	if opts.WriteTimeout == 0 {
		opts.WriteTimeout = 10 * time.Second
	}
	if opts.IdleTimeout == 0 {
		opts.IdleTimeout = 90 * time.Second
	}
	if opts.MinSubscribeInterval == 0 {
		opts.MinSubscribeInterval = time.Second
	}
	if opts.MembershipRecheckInterval == 0 {
		opts.MembershipRecheckInterval = 15 * time.Second
	}
	return &Hub{auth: a, vaults: v, bus: b, log: log, opts: opts}
}

// Wait blocks until every socket the hub is serving has finished. Call it
// after http.Server.Shutdown (which does not wait for hijacked connections)
// has returned and the sockets' request contexts are cancelled, and before
// closing the store. No new sockets may be accepted once Wait is called.
func (h *Hub) Wait() { h.wg.Wait() }

func (h *Hub) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	h.wg.Add(1)
	defer h.wg.Done()
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

	lastSubscribe time.Time // zero until the first Subscribe
	lastRecheck   time.Time // zero until the first membership recheck

	mu   sync.Mutex
	subs map[string]func() // vault id → bus cancel
}

func (c *conn) run() error {
	if err := c.authenticate(); err != nil {
		return err
	}
	for {
		var f obsyncv1.ClientFrame
		if err := c.readIdle(&f); err != nil {
			return err
		}
		// Every frame revalidates the token, so a revoked device can't stay
		// connected by sending frames other than Ping.
		if _, err := c.hub.auth.Authenticate(c.ctx, c.token); err != nil {
			return c.fail(err)
		}
		switch m := f.Frame.(type) {
		case *obsyncv1.ClientFrame_Subscribe:
			now := time.Now()
			if !c.lastSubscribe.IsZero() && now.Sub(c.lastSubscribe) < c.hub.opts.MinSubscribeInterval {
				return c.fail(apperr.New(apperr.RateLimited, "subscribe sent too soon after the previous one"))
			}
			c.lastSubscribe = now
			c.subscribe(m.Subscribe.GetVaultIds())
		case *obsyncv1.ClientFrame_Ping:
			c.recheckMembership()
			pong := &obsyncv1.ServerFrame{Frame: &obsyncv1.ServerFrame_Pong{Pong: &obsyncv1.Pong{Nonce: m.Ping.GetNonce()}}}
			if err := c.send(pong); err != nil {
				return err
			}
		default:
			return c.fail(apperr.New(apperr.Invalid, "unexpected frame"))
		}
	}
}

// readIdle reads the next frame, closing the socket if none arrives within
// IdleTimeout. This reaps half-open sockets and bounds how long a revoked
// device that never pings can keep receiving notifications.
func (c *conn) readIdle(f *obsyncv1.ClientFrame) error {
	ctx, cancel := context.WithTimeout(c.ctx, c.hub.opts.IdleTimeout)
	defer cancel()
	return c.read(ctx, f) // a cancelled Read closes the socket
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
			c.sendError(apperr.New(apperr.NotFound, "vault not found"))
			continue
		}
		// Subscribe before reading the seq, so a commit landing in between is
		// delivered rather than missed.
		ch, cancel := c.hub.bus.Subscribe(id)
		v, err := c.hub.vaults.VaultForMember(c.ctx, id, c.sess.UserID)
		if err != nil {
			cancel()
			if errors.Is(err, store.ErrNotFound) {
				c.sendError(apperr.New(apperr.NotFound, "vault not found"))
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
		c.hub.wg.Add(1)
		go c.forward(id, v.Seq, ch)
	}
}

// forward sends the vault's current seq, then each live notification. The
// bus subscription is opened before seq is read, so a delayed publish can
// carry a seq at or below one already sent; those are dropped so the client
// only ever sees seq increase.
func (c *conn) forward(vaultID string, seq int64, ch <-chan bus.Notify) {
	defer c.hub.wg.Done()
	if err := c.sendNotify(vaultID, seq); err != nil {
		return
	}
	last := seq
	for n := range ch {
		if n.Seq <= last {
			continue
		}
		last = n.Seq
		if err := c.sendNotify(n.VaultID, n.Seq); err != nil {
			return
		}
	}
}

// recheckMembership drops subscriptions to vaults the user can no longer
// access, telling the client with a NOT_FOUND Error frame for each (the
// socket stays open). Membership is otherwise checked only at Subscribe, so
// without this a removed member would keep receiving notifications for as
// long as the socket stays open. It runs at most once per
// MembershipRecheckInterval. Lookup failures other than not-found keep the
// subscription: a transient store error must not silently unsubscribe.
func (c *conn) recheckMembership() {
	now := time.Now()
	if !c.lastRecheck.IsZero() && now.Sub(c.lastRecheck) < c.hub.opts.MembershipRecheckInterval {
		return
	}
	c.lastRecheck = now
	c.mu.Lock()
	vaultIDs := make([]string, 0, len(c.subs))
	for id := range c.subs {
		vaultIDs = append(vaultIDs, id)
	}
	c.mu.Unlock()
	for _, id := range vaultIDs {
		_, err := c.hub.vaults.VaultForMember(c.ctx, id, c.sess.UserID)
		switch {
		case err == nil:
		case errors.Is(err, store.ErrNotFound):
			c.mu.Lock()
			cancel, ok := c.subs[id]
			if ok {
				cancel()
				delete(c.subs, id)
			}
			c.mu.Unlock()
			if ok {
				// The Error frame has no vault field, so the message is the
				// same fixed one Subscribe sends.
				c.sendError(apperr.New(apperr.NotFound, "vault not found"))
			}
		default:
			c.hub.log.Error("recheck membership", "vault", id, "err", err)
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
