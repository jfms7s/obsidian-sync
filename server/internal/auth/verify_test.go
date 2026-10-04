package auth_test

import (
	"errors"
	"strings"
	"testing"

	"github.com/jfms7s/obsidian-sync/server/internal/apperr"
	"github.com/jfms7s/obsidian-sync/server/internal/auth"
	"github.com/jfms7s/obsidian-sync/server/internal/ids"
	"github.com/jfms7s/obsidian-sync/server/internal/store"
)

func aliceID(t *testing.T, st *store.Store) string {
	t.Helper()
	u, err := st.UserByUsername(ctx, "alice")
	if err != nil {
		t.Fatal(err)
	}
	return u.ID
}

func TestVerifyUserPassword(t *testing.T) {
	svc, st, _ := newService(t)
	id := aliceID(t, st)

	if err := svc.VerifyUserPassword(ctx, id, "correct horse"); err != nil {
		t.Fatalf("right password: %v", err)
	}
	err := svc.VerifyUserPassword(ctx, id, "nope")
	if !errors.Is(err, auth.ErrWrongPassword) || apperr.CodeOf(err) != apperr.WrongPassword {
		t.Fatalf("wrong password: %v", err)
	}
	err = svc.VerifyUserPassword(ctx, id, "")
	if apperr.CodeOf(err) != apperr.WrongPassword {
		t.Fatalf("empty password: %v", err)
	}
	err = svc.VerifyUserPassword(ctx, id, strings.Repeat("x", 1025))
	if apperr.CodeOf(err) != apperr.Invalid {
		t.Fatalf("overlong password: %v", err)
	}
	if err := svc.VerifyUserPassword(ctx, ids.New(), "correct horse"); !errors.Is(err, auth.ErrUnauthorized) {
		t.Fatalf("unknown user: %v", err)
	}
}

// Guesses through VerifyUserPassword and through Login draw on one budget.
func TestVerifyUserPasswordSharesTheLoginLimiter(t *testing.T) {
	svc, st, _ := newService(t)
	id := aliceID(t, st)

	for i := 0; i < 3; i++ {
		_ = svc.VerifyUserPassword(ctx, id, "guess")
	}
	for i := 0; i < 2; i++ {
		_, _ = svc.Login(ctx, auth.LoginRequest{Username: "ALICE", Password: "guess"})
	}
	if _, err := svc.Login(ctx, auth.LoginRequest{Username: "alice", Password: "correct horse"}); !errors.Is(err, auth.ErrRateLimited) {
		t.Fatalf("login after 5 mixed guesses: %v, want rate limited", err)
	}
	if err := svc.VerifyUserPassword(ctx, id, "correct horse"); !errors.Is(err, auth.ErrRateLimited) {
		t.Fatalf("verify after 5 mixed guesses: %v, want rate limited", err)
	}
}

// An empty password is a missing one: it is refused without spending a
// guess or running argon2.
func TestVerifyUserPasswordEmptyCostsNothing(t *testing.T) {
	svc, st, _ := newService(t)
	id := aliceID(t, st)
	var calls int
	auth.SetVerify(svc, func(password, encoded string) (bool, error) {
		calls++
		return auth.VerifyPassword(password, encoded)
	})
	for i := 0; i < 10; i++ {
		_ = svc.VerifyUserPassword(ctx, id, "")
	}
	if calls != 0 {
		t.Fatalf("argon2 ran %d times for empty passwords", calls)
	}
	if err := svc.VerifyUserPassword(ctx, id, "correct horse"); err != nil {
		t.Fatalf("right password after empty ones: %v", err)
	}
}

func TestVerifyUserPasswordSuccessResetsTheBudget(t *testing.T) {
	svc, st, _ := newService(t)
	id := aliceID(t, st)
	for i := 0; i < 4; i++ {
		_ = svc.VerifyUserPassword(ctx, id, "guess")
	}
	if err := svc.VerifyUserPassword(ctx, id, "correct horse"); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 4; i++ {
		_ = svc.VerifyUserPassword(ctx, id, "guess")
	}
	if err := svc.VerifyUserPassword(ctx, id, "correct horse"); err != nil {
		t.Fatalf("budget was not reset by the earlier success: %v", err)
	}
}

func TestVerifyUserPasswordMalformedHashIsInternal(t *testing.T) {
	svc, st, _ := newService(t)
	u := store.User{ID: ids.New(), Username: "bob", PasswordHash: "$argon2id$v=19$m=1,t=1,p=1$$", QuotaBytes: 1}
	if err := st.CreateUser(ctx, u); err != nil {
		t.Fatal(err)
	}
	err := svc.VerifyUserPassword(ctx, u.ID, "x")
	if err == nil || errors.Is(err, auth.ErrWrongPassword) || apperr.CodeOf(err) != apperr.Internal {
		t.Fatalf("err = %v", err)
	}
}
