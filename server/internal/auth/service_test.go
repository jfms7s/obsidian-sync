package auth_test

import (
	"context"
	"errors"
	"testing"
	"time"

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
