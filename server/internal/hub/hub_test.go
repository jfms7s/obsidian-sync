package hub_test

import (
	"context"
	"io"
	"log/slog"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"google.golang.org/protobuf/proto"

	"github.com/jfms7s/obsidian-sync/server/internal/apperr"
	"github.com/jfms7s/obsidian-sync/server/internal/auth"
	"github.com/jfms7s/obsidian-sync/server/internal/bus"
	obsyncv1 "github.com/jfms7s/obsidian-sync/server/internal/gen/obsync/v1"
	"github.com/jfms7s/obsidian-sync/server/internal/hub"
	"github.com/jfms7s/obsidian-sync/server/internal/ids"
	"github.com/jfms7s/obsidian-sync/server/internal/store"
	"github.com/jfms7s/obsidian-sync/server/internal/store/storetest"
)

var ctx = context.Background()

// revocableVaults wraps the store so a test can take away a user's access
// to a vault (the store has no remove-member operation).
type revocableVaults struct {
	*store.Store
	mu      sync.Mutex
	revoked map[string]bool // vault id
	calls   int             // VaultForMember calls
}

func (v *revocableVaults) VaultForMember(ctx context.Context, vaultID, userID string) (store.Vault, error) {
	v.mu.Lock()
	revoked := v.revoked[vaultID]
	v.calls++
	v.mu.Unlock()
	if revoked {
		return store.Vault{}, store.ErrNotFound
	}
	return v.Store.VaultForMember(ctx, vaultID, userID)
}

func (v *revocableVaults) callCount() int {
	v.mu.Lock()
	defer v.mu.Unlock()
	return v.calls
}

func (v *revocableVaults) revoke(vaultID string) {
	v.mu.Lock()
	defer v.mu.Unlock()
	v.revoked[vaultID] = true
}

type env struct {
	t      *testing.T
	url    string
	st     *store.Store
	vaults *revocableVaults
	bus    *bus.Memory
	auth   *auth.Service
	hub    *hub.Hub
	token  string
	dev    store.Device
	vault  store.Vault
}

func newEnv(t *testing.T) *env {
	t.Helper()
	// Several tests re-subscribe back to back or expect every Ping to recheck
	// membership; the pacing rules have their own tests.
	return newEnvOpts(t, hub.Options{AuthTimeout: 200 * time.Millisecond, MinSubscribeInterval: time.Nanosecond,
		MembershipRecheckInterval: time.Nanosecond})
}

func newEnvOpts(t *testing.T, opts hub.Options) *env {
	t.Helper()
	st, clk := storetest.New(t)
	authSvc, err := auth.NewService(st, auth.Options{Params: auth.FastParams, Now: clk.Now})
	if err != nil {
		t.Fatal(err)
	}
	hash, _ := auth.HashPassword("pw", auth.FastParams)
	user := store.User{ID: ids.New(), Username: "alice", PasswordHash: hash, QuotaBytes: 1}
	if err := st.CreateUser(ctx, user); err != nil {
		t.Fatal(err)
	}
	res, err := authSvc.Login(ctx, auth.LoginRequest{Username: "alice", Password: "pw"})
	if err != nil {
		t.Fatal(err)
	}
	b := bus.NewMemory()
	vaults := &revocableVaults{Store: st, revoked: map[string]bool{}}
	h := hub.New(authSvc, vaults, b, slog.New(slog.NewTextHandler(io.Discard, nil)), opts)
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	return &env{t: t, url: "ws" + strings.TrimPrefix(srv.URL, "http"), st: st, vaults: vaults, bus: b, auth: authSvc, hub: h,
		token: res.Token, dev: res.Device, vault: storetest.SeedVault(t, st, user.ID)}
}

func (e *env) dial() *websocket.Conn {
	e.t.Helper()
	c, _, err := websocket.Dial(ctx, e.url, nil)
	if err != nil {
		e.t.Fatal(err)
	}
	e.t.Cleanup(func() { c.CloseNow() })
	return c
}

func send(t *testing.T, c *websocket.Conn, f *obsyncv1.ClientFrame) {
	t.Helper()
	data, _ := proto.Marshal(f)
	if err := c.Write(ctx, websocket.MessageBinary, data); err != nil {
		t.Fatal(err)
	}
}

func recv(t *testing.T, c *websocket.Conn) *obsyncv1.ServerFrame {
	t.Helper()
	rctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	_, data, err := c.Read(rctx)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	var f obsyncv1.ServerFrame
	if err := proto.Unmarshal(data, &f); err != nil {
		t.Fatal(err)
	}
	return &f
}

func expectClosed(t *testing.T, c *websocket.Conn) {
	t.Helper()
	rctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	if _, _, err := c.Read(rctx); err == nil {
		t.Fatal("socket still open")
	} else if rctx.Err() != nil {
		t.Fatal("socket not closed in time")
	}
}

func authFrame(token string) *obsyncv1.ClientFrame {
	return &obsyncv1.ClientFrame{Frame: &obsyncv1.ClientFrame_Auth{Auth: &obsyncv1.Auth{Token: token}}}
}

func subscribeFrame(ids ...string) *obsyncv1.ClientFrame {
	return &obsyncv1.ClientFrame{Frame: &obsyncv1.ClientFrame_Subscribe{Subscribe: &obsyncv1.Subscribe{VaultIds: ids}}}
}

func pingFrame(n uint64) *obsyncv1.ClientFrame {
	return &obsyncv1.ClientFrame{Frame: &obsyncv1.ClientFrame_Ping{Ping: &obsyncv1.Ping{Nonce: n}}}
}

func (e *env) authed() *websocket.Conn {
	e.t.Helper()
	c := e.dial()
	send(e.t, c, authFrame(e.token))
	if f := recv(e.t, c); f.GetAuthOk().GetDeviceId() != e.dev.ID {
		e.t.Fatalf("auth reply = %v", f)
	}
	return c
}

func TestUnauthenticatedSocketIsClosed(t *testing.T) {
	e := newEnv(t)
	expectClosed(t, e.dial())
}

func TestBadTokenGetsUnauthorized(t *testing.T) {
	e := newEnv(t)
	c := e.dial()
	send(t, c, authFrame("nope"))
	if f := recv(t, c); f.GetError().GetCode() != apperr.Unauthorized {
		t.Fatalf("frame = %v", f)
	}
	expectClosed(t, c)
}

func TestSubscribeSendsCurrentSeqThenLiveNotifies(t *testing.T) {
	e := newEnv(t)
	c := e.authed()
	send(t, c, subscribeFrame(e.vault.ID))
	if n := recv(t, c).GetNotify(); n.GetVaultId() != e.vault.ID || n.GetSeq() != 0 {
		t.Fatalf("initial notify = %v", n)
	}
	if err := e.bus.Publish(ctx, bus.Notify{VaultID: e.vault.ID, Seq: 5}); err != nil {
		t.Fatal(err)
	}
	if n := recv(t, c).GetNotify(); n.GetSeq() != 5 {
		t.Fatalf("live notify = %v", n)
	}
}

func TestSubscribeToForeignVault(t *testing.T) {
	e := newEnv(t)
	bob := storetest.SeedUser(t, e.st, "bob")
	foreign := storetest.SeedVault(t, e.st, bob.ID)
	c := e.authed()
	send(t, c, subscribeFrame(foreign.ID))
	if f := recv(t, c); f.GetError().GetCode() != apperr.NotFound {
		t.Fatalf("frame = %v", f)
	}
	send(t, c, pingFrame(1))
	if f := recv(t, c); f.GetPong().GetNonce() != 1 {
		t.Fatalf("socket should stay usable, got %v", f)
	}
}

func TestPingRevalidatesToken(t *testing.T) {
	e := newEnv(t)
	c := e.authed()
	send(t, c, pingFrame(7))
	if f := recv(t, c); f.GetPong().GetNonce() != 7 {
		t.Fatalf("frame = %v", f)
	}
	if err := e.st.RevokeDevice(ctx, e.dev.UserID, e.dev.ID); err != nil {
		t.Fatal(err)
	}
	send(t, c, pingFrame(8))
	if f := recv(t, c); f.GetError().GetCode() != apperr.DeviceRevoked {
		t.Fatalf("frame = %v", f)
	}
	expectClosed(t, c)
}

// expectPongNext pings and fails if any frame other than the matching Pong
// arrives first, which would reveal a leaked duplicate subscription.
func expectPongNext(t *testing.T, c *websocket.Conn, nonce uint64) {
	t.Helper()
	send(t, c, pingFrame(nonce))
	if f := recv(t, c); f.GetPong().GetNonce() != nonce {
		t.Fatalf("expected pong %d, got %v", nonce, f)
	}
}

func TestSubscribeDeduplicatesVaultIDs(t *testing.T) {
	e := newEnv(t)
	c := e.authed()
	send(t, c, subscribeFrame(e.vault.ID, e.vault.ID))
	if n := recv(t, c).GetNotify(); n.GetVaultId() != e.vault.ID || n.GetSeq() != 0 {
		t.Fatalf("initial notify = %v", n)
	}
	if err := e.bus.Publish(ctx, bus.Notify{VaultID: e.vault.ID, Seq: 5}); err != nil {
		t.Fatal(err)
	}
	if n := recv(t, c).GetNotify(); n.GetSeq() != 5 {
		t.Fatalf("live notify = %v", n)
	}
	expectPongNext(t, c, 1)
	if err := e.bus.Publish(ctx, bus.Notify{VaultID: e.vault.ID, Seq: 6}); err != nil {
		t.Fatal(err)
	}
	if n := recv(t, c).GetNotify(); n.GetSeq() != 6 {
		t.Fatalf("live notify = %v", n)
	}
	expectPongNext(t, c, 2)
}

func TestResubscribeReplacesExistingSubscription(t *testing.T) {
	e := newEnv(t)
	c := e.authed()
	send(t, c, subscribeFrame(e.vault.ID))
	if n := recv(t, c).GetNotify(); n.GetSeq() != 0 {
		t.Fatalf("initial notify = %v", n)
	}
	send(t, c, subscribeFrame(e.vault.ID))
	if n := recv(t, c).GetNotify(); n.GetSeq() != 0 {
		t.Fatalf("re-subscribe notify = %v", n)
	}
	expectPongNext(t, c, 1)
	if err := e.bus.Publish(ctx, bus.Notify{VaultID: e.vault.ID, Seq: 5}); err != nil {
		t.Fatal(err)
	}
	if n := recv(t, c).GetNotify(); n.GetSeq() != 5 {
		t.Fatalf("live notify = %v", n)
	}
	expectPongNext(t, c, 2)
}

func TestIdleSocketIsClosed(t *testing.T) {
	e := newEnvOpts(t, hub.Options{IdleTimeout: 300 * time.Millisecond})
	c := e.authed()
	expectClosed(t, c)
}

func TestPingingSocketStaysOpen(t *testing.T) {
	e := newEnvOpts(t, hub.Options{IdleTimeout: 300 * time.Millisecond})
	c := e.authed()
	for i := uint64(1); i <= 10; i++ {
		time.Sleep(100 * time.Millisecond)
		expectPongNext(t, c, i)
	}
}

// A revoked device that never pings must not keep receiving notifications:
// the idle timeout closes the socket.
func TestRevokedSilentSocketStopsGettingNotifies(t *testing.T) {
	e := newEnvOpts(t, hub.Options{IdleTimeout: 300 * time.Millisecond})
	c := e.authed()
	send(t, c, subscribeFrame(e.vault.ID))
	if n := recv(t, c).GetNotify(); n.GetSeq() != 0 {
		t.Fatalf("initial notify = %v", n)
	}
	if err := e.st.RevokeDevice(ctx, e.dev.UserID, e.dev.ID); err != nil {
		t.Fatal(err)
	}
	time.Sleep(500 * time.Millisecond)
	if err := e.bus.Publish(ctx, bus.Notify{VaultID: e.vault.ID, Seq: 5}); err != nil {
		t.Fatal(err)
	}
	expectClosed(t, c)
}

func TestNotifiesAreMonotonic(t *testing.T) {
	e := newEnv(t)
	c := e.authed()
	send(t, c, subscribeFrame(e.vault.ID))
	if n := recv(t, c).GetNotify(); n.GetSeq() != 0 {
		t.Fatalf("initial notify = %v", n)
	}
	// A stale publish (not higher than what was already sent) is dropped.
	if err := e.bus.Publish(ctx, bus.Notify{VaultID: e.vault.ID, Seq: 0}); err != nil {
		t.Fatal(err)
	}
	time.Sleep(50 * time.Millisecond)
	if err := e.bus.Publish(ctx, bus.Notify{VaultID: e.vault.ID, Seq: 3}); err != nil {
		t.Fatal(err)
	}
	if n := recv(t, c).GetNotify(); n.GetSeq() != 3 {
		t.Fatalf("notify = %v, want seq 3", n)
	}
	if err := e.bus.Publish(ctx, bus.Notify{VaultID: e.vault.ID, Seq: 2}); err != nil {
		t.Fatal(err)
	}
	expectPongNext(t, c, 1)
}

func TestWaitReturnsAfterSocketsClose(t *testing.T) {
	e := newEnv(t)
	c := e.authed()
	send(t, c, subscribeFrame(e.vault.ID))
	recv(t, c)
	done := make(chan struct{})
	go func() { e.hub.Wait(); close(done) }()
	select {
	case <-done:
		t.Fatal("Wait returned while a socket was open")
	case <-time.After(100 * time.Millisecond):
	}
	c.Close(websocket.StatusNormalClosure, "")
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("Wait did not return after the socket closed")
	}
}

func TestSubscribeNotFoundDoesNotEchoInput(t *testing.T) {
	e := newEnv(t)
	c := e.authed()
	send(t, c, subscribeFrame("<script>"))
	f := recv(t, c).GetError()
	if f.GetCode() != apperr.NotFound || strings.Contains(f.GetMessage(), "script") {
		t.Fatalf("error = %v", f)
	}
}

// Any frame, not just Ping, revalidates the token: a revoked device that keeps
// the socket alive with Subscribe frames must still be cut off.
func TestSubscribeRevalidatesToken(t *testing.T) {
	e := newEnv(t)
	c := e.authed()
	send(t, c, subscribeFrame(e.vault.ID))
	if n := recv(t, c).GetNotify(); n.GetSeq() != 0 {
		t.Fatalf("initial notify = %v", n)
	}
	if err := e.st.RevokeDevice(ctx, e.dev.UserID, e.dev.ID); err != nil {
		t.Fatal(err)
	}
	send(t, c, subscribeFrame(e.vault.ID))
	if f := recv(t, c); f.GetError().GetCode() != apperr.DeviceRevoked {
		t.Fatalf("frame = %v", f)
	}
	expectClosed(t, c)
}

// Membership is rechecked on Ping: once the user loses access to a vault, its
// subscription is dropped, the client is told with a NOT_FOUND Error frame
// (the socket stays open) and no further notifies arrive, while subscriptions
// to vaults still accessible keep working.
func TestPingDropsSubscriptionsToVaultsNoLongerAccessible(t *testing.T) {
	e := newEnv(t)
	other := storetest.SeedVault(t, e.st, e.dev.UserID)
	c := e.authed()
	send(t, c, subscribeFrame(e.vault.ID, other.ID))
	got := map[string]bool{}
	for i := 0; i < 2; i++ {
		got[recv(t, c).GetNotify().GetVaultId()] = true
	}
	if !got[e.vault.ID] || !got[other.ID] {
		t.Fatalf("initial notifies for %v", got)
	}
	e.vaults.revoke(e.vault.ID)
	send(t, c, pingFrame(1))
	if f := recv(t, c).GetError(); f.GetCode() != apperr.NotFound || f.GetMessage() != "vault not found" {
		t.Fatalf("frame = %v, want NOT_FOUND for the dropped vault", f)
	}
	if f := recv(t, c); f.GetPong().GetNonce() != 1 {
		t.Fatalf("frame = %v, want pong 1", f)
	}
	if err := e.bus.Publish(ctx, bus.Notify{VaultID: e.vault.ID, Seq: 5}); err != nil {
		t.Fatal(err)
	}
	if err := e.bus.Publish(ctx, bus.Notify{VaultID: other.ID, Seq: 3}); err != nil {
		t.Fatal(err)
	}
	if n := recv(t, c).GetNotify(); n.GetVaultId() != other.ID || n.GetSeq() != 3 {
		t.Fatalf("notify = %v, want only the still-accessible vault", n)
	}
	expectPongNext(t, c, 2)
}

// A Subscribe sent sooner than MinSubscribeInterval after the previous one is
// answered with RATE_LIMITED and the socket is closed; one sent after the
// interval is accepted.
func TestSubscribeIsRateLimited(t *testing.T) {
	e := newEnvOpts(t, hub.Options{MinSubscribeInterval: 300 * time.Millisecond})
	c := e.authed()
	send(t, c, subscribeFrame(e.vault.ID))
	if n := recv(t, c).GetNotify(); n.GetSeq() != 0 {
		t.Fatalf("initial notify = %v", n)
	}
	time.Sleep(350 * time.Millisecond)
	send(t, c, subscribeFrame(e.vault.ID))
	if n := recv(t, c).GetNotify(); n.GetSeq() != 0 {
		t.Fatalf("paced re-subscribe notify = %v", n)
	}
	send(t, c, subscribeFrame(e.vault.ID))
	if f := recv(t, c); f.GetError().GetCode() != apperr.RateLimited {
		t.Fatalf("frame = %v, want RATE_LIMITED", f)
	}
	expectClosed(t, c)
}

// With no MinSubscribeInterval set, the default (1s) applies.
func TestSubscribeRateLimitDefault(t *testing.T) {
	e := newEnvOpts(t, hub.Options{})
	c := e.authed()
	send(t, c, subscribeFrame(e.vault.ID))
	recv(t, c)
	send(t, c, subscribeFrame(e.vault.ID))
	if f := recv(t, c); f.GetError().GetCode() != apperr.RateLimited {
		t.Fatalf("frame = %v, want RATE_LIMITED", f)
	}
	expectClosed(t, c)
}

// Pings are not rate limited, so the membership recheck they trigger runs at
// most once per MembershipRecheckInterval per socket.
func TestMembershipRecheckIsThrottled(t *testing.T) {
	e := newEnvOpts(t, hub.Options{MinSubscribeInterval: time.Nanosecond, MembershipRecheckInterval: 300 * time.Millisecond})
	c := e.authed()
	send(t, c, subscribeFrame(e.vault.ID))
	if n := recv(t, c).GetNotify(); n.GetSeq() != 0 {
		t.Fatalf("initial notify = %v", n)
	}
	expectPongNext(t, c, 1) // first ping rechecks
	base := e.vaults.callCount()
	for i := uint64(2); i < 12; i++ {
		expectPongNext(t, c, i)
	}
	if n := e.vaults.callCount(); n != base {
		t.Fatalf("%d membership queries from pings within the interval, want 0", n-base)
	}
	time.Sleep(350 * time.Millisecond)
	expectPongNext(t, c, 99)
	if n := e.vaults.callCount(); n != base+1 {
		t.Fatalf("%d membership queries after the interval, want 1", n-base)
	}
}
