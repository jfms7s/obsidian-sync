package auth_test

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jfms7s/obsidian-sync/server/internal/apperr"
	"github.com/jfms7s/obsidian-sync/server/internal/auth"
	"github.com/jfms7s/obsidian-sync/server/internal/ids"
	"github.com/jfms7s/obsidian-sync/server/internal/store"
	"github.com/jfms7s/obsidian-sync/server/internal/store/storetest"
)

var ctx = context.Background()

func newService(t *testing.T) (*auth.Service, *store.Store, *storetest.Clock) {
	t.Helper()
	st, clk := storetest.New(t)
	hash, err := auth.HashPassword("correct horse", auth.FastParams)
	if err != nil {
		t.Fatal(err)
	}
	if err := st.CreateUser(ctx, store.User{ID: ids.New(), Username: "alice", PasswordHash: hash, QuotaBytes: 1}); err != nil {
		t.Fatal(err)
	}
	svc, err := auth.NewService(st, auth.Options{Params: auth.FastParams, Now: clk.Now})
	if err != nil {
		t.Fatal(err)
	}
	return svc, st, clk
}

func TestLoginThenAuthenticate(t *testing.T) {
	svc, _, _ := newService(t)
	res, err := svc.Login(ctx, auth.LoginRequest{Username: "Alice", Password: "correct horse", DeviceName: "  laptop ", Platform: "linux"})
	if err != nil {
		t.Fatal(err)
	}
	if res.Token == "" || res.Device.Name != "laptop" || res.Device.Platform != "linux" {
		t.Fatalf("res = %+v", res)
	}
	sess, err := svc.Authenticate(ctx, res.Token)
	if err != nil || sess.DeviceID != res.Device.ID || sess.UserID != res.Device.UserID {
		t.Fatalf("sess = %+v, err %v", sess, err)
	}
}

func TestLoginFailures(t *testing.T) {
	svc, _, _ := newService(t)
	if _, err := svc.Login(ctx, auth.LoginRequest{Username: "alice", Password: "nope"}); !errors.Is(err, auth.ErrInvalidCredentials) {
		t.Fatalf("wrong password err = %v", err)
	}
	if _, err := svc.Login(ctx, auth.LoginRequest{Username: "mallory", Password: "x"}); !errors.Is(err, auth.ErrInvalidCredentials) {
		t.Fatalf("unknown user err = %v", err)
	}
}

func TestLoginIsRateLimitedPerUsername(t *testing.T) {
	svc, _, clk := newService(t)
	for i := 0; i < 5; i++ {
		_, _ = svc.Login(ctx, auth.LoginRequest{Username: "alice", Password: "guess"})
	}
	if _, err := svc.Login(ctx, auth.LoginRequest{Username: "ALICE", Password: "correct horse"}); !errors.Is(err, auth.ErrRateLimited) {
		t.Fatalf("err = %v, want rate limited even with the right password", err)
	}
	clk.Advance(time.Minute)
	if _, err := svc.Login(ctx, auth.LoginRequest{Username: "alice", Password: "correct horse"}); err != nil {
		t.Fatalf("after refill: %v", err)
	}
}

func TestAuthenticateRejections(t *testing.T) {
	svc, st, _ := newService(t)
	if _, err := svc.Authenticate(ctx, ""); !errors.Is(err, auth.ErrUnauthorized) {
		t.Fatalf("empty token err = %v", err)
	}
	if _, err := svc.Authenticate(ctx, "not-a-token"); !errors.Is(err, auth.ErrUnauthorized) {
		t.Fatalf("unknown token err = %v", err)
	}
	res, _ := svc.Login(ctx, auth.LoginRequest{Username: "alice", Password: "correct horse"})
	if err := st.RevokeDevice(ctx, res.Device.UserID, res.Device.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Authenticate(ctx, res.Token); !errors.Is(err, auth.ErrDeviceRevoked) {
		t.Fatalf("revoked err = %v", err)
	}
}

func TestAuthenticateRefreshesLastSeenAtMostOncePerMinute(t *testing.T) {
	svc, st, clk := newService(t)
	res, _ := svc.Login(ctx, auth.LoginRequest{Username: "alice", Password: "correct horse"})
	start := clk.Now().UnixMilli()

	clk.Advance(30 * time.Second)
	_, _ = svc.Authenticate(ctx, res.Token)
	if d, _ := st.DeviceByTokenHash(ctx, auth.HashToken(res.Token)); d.LastSeenAtMs != start {
		t.Fatalf("touched too early: %d", d.LastSeenAtMs)
	}
	clk.Advance(61 * time.Second)
	_, _ = svc.Authenticate(ctx, res.Token)
	if d, _ := st.DeviceByTokenHash(ctx, auth.HashToken(res.Token)); d.LastSeenAtMs != clk.Now().UnixMilli() {
		t.Fatalf("not touched: %d", d.LastSeenAtMs)
	}
}

// slowVerify wraps auth.VerifyPassword, counting calls and tracking how many
// run at once.
type slowVerify struct {
	delay            time.Duration
	calls, cur, peak atomic.Int32
}

func (v *slowVerify) verify(password, encoded string) (bool, error) {
	v.calls.Add(1)
	n := v.cur.Add(1)
	defer v.cur.Add(-1)
	for {
		p := v.peak.Load()
		if n <= p || v.peak.CompareAndSwap(p, n) {
			break
		}
	}
	time.Sleep(v.delay)
	return auth.VerifyPassword(password, encoded)
}

func newServiceWith(t *testing.T, st auth.Store, opts auth.Options) *auth.Service {
	t.Helper()
	svc, err := auth.NewService(st, opts)
	if err != nil {
		t.Fatal(err)
	}
	return svc
}

func seedAlice(t *testing.T, st *store.Store, hash string) {
	t.Helper()
	if err := st.CreateUser(ctx, store.User{ID: ids.New(), Username: "alice", PasswordHash: hash, QuotaBytes: 1}); err != nil {
		t.Fatal(err)
	}
}

func TestConcurrentWrongPasswordsAreLimitedToBurst(t *testing.T) {
	st, clk := storetest.New(t)
	hash, _ := auth.HashPassword("correct horse", auth.FastParams)
	seedAlice(t, st, hash)
	svc := newServiceWith(t, st, auth.Options{Params: auth.FastParams, Now: clk.Now, MaxConcurrentVerifies: 100})
	v := &slowVerify{delay: 20 * time.Millisecond}
	auth.SetVerify(svc, v.verify)

	var wg sync.WaitGroup
	for i := 0; i < 100; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, _ = svc.Login(ctx, auth.LoginRequest{Username: "alice", Password: "guess"})
		}()
	}
	wg.Wait()
	if n := v.calls.Load(); n > 5 {
		t.Fatalf("%d password checks ran, want at most the burst of 5", n)
	}
}

func TestVerificationConcurrencyIsBounded(t *testing.T) {
	st, clk := storetest.New(t)
	svc := newServiceWith(t, st, auth.Options{Params: auth.FastParams, Now: clk.Now, MaxConcurrentVerifies: 2})
	v := &slowVerify{delay: 10 * time.Millisecond}
	auth.SetVerify(svc, v.verify)

	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			_, _ = svc.Login(ctx, auth.LoginRequest{Username: fmt.Sprintf("user%d", i), Password: "x"})
		}(i)
	}
	wg.Wait()
	if v.calls.Load() != 20 {
		t.Fatalf("calls = %d, want 20", v.calls.Load())
	}
	if p := v.peak.Load(); p > 2 {
		t.Fatalf("%d checks ran at once, want at most 2", p)
	}
}

func TestLoginGivesUpWaitingForAVerifySlotWhenContextEnds(t *testing.T) {
	st, clk := storetest.New(t)
	svc := newServiceWith(t, st, auth.Options{Params: auth.FastParams, Now: clk.Now, MaxConcurrentVerifies: 1})
	release := make(chan struct{})
	started := make(chan struct{})
	var once sync.Once
	auth.SetVerify(svc, func(password, encoded string) (bool, error) {
		once.Do(func() { close(started) })
		<-release
		return false, nil
	})
	done := make(chan struct{})
	go func() {
		defer close(done)
		_, _ = svc.Login(ctx, auth.LoginRequest{Username: "holder", Password: "x"})
	}()
	<-started

	cctx, cancel := context.WithTimeout(ctx, 20*time.Millisecond)
	defer cancel()
	if _, err := svc.Login(cctx, auth.LoginRequest{Username: "waiter", Password: "x"}); !errors.Is(err, auth.ErrRateLimited) {
		t.Fatalf("err = %v, want rate limited", err)
	}
	close(release)
	<-done
}

func TestMalformedStoredHashCountsAsFailure(t *testing.T) {
	st, clk := storetest.New(t)
	seedAlice(t, st, "$argon2id$v=19$m=1024,t=0,p=1$c2FsdHNhbHRzYWx0c2FsdA$a2V5a2V5a2V5a2V5a2V5a2V5a2V5a2V5a2V5a2V5a2U")
	svc := newServiceWith(t, st, auth.Options{Params: auth.FastParams, Now: clk.Now})
	for i := 0; i < 5; i++ {
		_, err := svc.Login(ctx, auth.LoginRequest{Username: "alice", Password: "x"})
		if err == nil || errors.Is(err, auth.ErrInvalidCredentials) || apperr.CodeOf(err) != apperr.Internal {
			t.Fatalf("attempt %d err = %v, want an internal error", i, err)
		}
	}
	if _, err := svc.Login(ctx, auth.LoginRequest{Username: "alice", Password: "x"}); !errors.Is(err, auth.ErrRateLimited) {
		t.Fatalf("err = %v, want rate limited", err)
	}
}

func TestZeroParamsUseDefaults(t *testing.T) {
	st, clk := storetest.New(t)
	svc := newServiceWith(t, st, auth.Options{Now: clk.Now})
	var seen []string
	auth.SetVerify(svc, func(_, encoded string) (bool, error) { seen = append(seen, encoded); return false, nil })
	_, _ = svc.Login(ctx, auth.LoginRequest{Username: "nobody", Password: "x"})
	want := fmt.Sprintf("$argon2id$v=19$m=%d,t=%d,p=%d$", auth.DefaultParams.Memory, auth.DefaultParams.Iterations, auth.DefaultParams.Parallelism)
	if len(seen) != 1 || !strings.HasPrefix(seen[0], want) {
		t.Fatalf("dummy hash = %q, want prefix %q", seen, want)
	}
}

func TestOverlongPasswordIsInvalid(t *testing.T) {
	svc, _, _ := newService(t)
	v := &slowVerify{}
	auth.SetVerify(svc, v.verify)
	_, err := svc.Login(ctx, auth.LoginRequest{Username: "alice", Password: strings.Repeat("a", 1025)})
	if apperr.CodeOf(err) != apperr.Invalid {
		t.Fatalf("err = %v, want INVALID", err)
	}
	if v.calls.Load() != 0 {
		t.Fatal("an overlong password was verified")
	}
	if _, err := svc.Login(ctx, auth.LoginRequest{Username: "alice", Password: "correct horse"}); err != nil {
		t.Fatalf("1024-byte limit broke a normal login: %v", err)
	}
}

type failingTouch struct{ *store.Store }

func (failingTouch) TouchDevice(context.Context, string) error {
	return errors.New("database is locked")
}

func TestAuthenticateIgnoresTouchFailures(t *testing.T) {
	st, clk := storetest.New(t)
	hash, _ := auth.HashPassword("correct horse", auth.FastParams)
	seedAlice(t, st, hash)
	svc := newServiceWith(t, failingTouch{st}, auth.Options{Params: auth.FastParams, Now: clk.Now})
	res, err := svc.Login(ctx, auth.LoginRequest{Username: "alice", Password: "correct horse"})
	if err != nil {
		t.Fatal(err)
	}
	clk.Advance(2 * time.Minute)
	if _, err := svc.Authenticate(ctx, res.Token); err != nil {
		t.Fatalf("a failed last-seen update rejected a valid token: %v", err)
	}
}
