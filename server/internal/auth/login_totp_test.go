package auth_test

import (
	"errors"
	"testing"
	"time"

	"github.com/jfms7s/obsidian-sync/server/internal/apperr"
	"github.com/jfms7s/obsidian-sync/server/internal/auth"
	"github.com/jfms7s/obsidian-sync/server/internal/store"
	"github.com/jfms7s/obsidian-sync/server/internal/store/storetest"
)

var totpSecret = []byte("12345678901234567890")

// withTOTP turns TOTP on for alice and returns her recovery codes.
func withTOTP(t *testing.T, st *store.Store) []string {
	t.Helper()
	u, err := st.UserByUsername(ctx, "alice")
	if err != nil {
		t.Fatal(err)
	}
	shown, hashes, err := auth.NewRecoveryCodes()
	if err != nil {
		t.Fatal(err)
	}
	if err := st.EnableTOTP(ctx, u.ID, totpSecret, 0, hashes); err != nil {
		t.Fatal(err)
	}
	return shown
}

func codeAt(clk *storetest.Clock) string { return auth.TOTPCode(totpSecret, auth.TOTPStep(clk.Now())) }

func login(svc *auth.Service, password, code string) error {
	_, err := svc.Login(ctx, auth.LoginRequest{Username: "alice", Password: password, TOTPCode: code, DeviceName: "d"})
	return err
}

func TestLoginWithTOTP(t *testing.T) {
	svc, st, clk := newService(t)
	// A code sent for an account without TOTP is ignored.
	if err := login(svc, "correct horse", "123456"); err != nil {
		t.Fatalf("TOTP off, code sent: %v", err)
	}
	withTOTP(t, st)

	err := login(svc, "correct horse", "")
	if apperr.CodeOf(err) != apperr.SecondFactorRequired || !errors.Is(err, auth.ErrSecondFactorRequired) {
		t.Fatalf("right password, no code: err = %v, want SECOND_FACTOR_REQUIRED", err)
	}
	if err := login(svc, "correct horse", codeAt(clk)); err != nil {
		t.Fatalf("right password and code: %v", err)
	}
	// The same code again (same step) is a replay.
	if err := login(svc, "correct horse", codeAt(clk)); !errors.Is(err, auth.ErrInvalidCredentials) {
		t.Fatalf("replayed code: err = %v", err)
	}
	clk.Advance(30 * time.Second)
	if err := login(svc, "correct horse", codeAt(clk)); err != nil {
		t.Fatalf("next step's code: %v", err)
	}
}

// Whether the password or the code was wrong, the answer is the same.
func TestLoginWithTOTPDoesNotSayWhichFactorFailed(t *testing.T) {
	svc, st, clk := newService(t)
	withTOTP(t, st)
	wrongPassword := login(svc, "wrong password", codeAt(clk))
	wrongCode := login(svc, "correct horse", "000000")
	unknownUser := func() error {
		_, err := svc.Login(ctx, auth.LoginRequest{Username: "mallory", Password: "x", TOTPCode: codeAt(clk)})
		return err
	}()
	for name, err := range map[string]error{"wrong password": wrongPassword, "wrong code": wrongCode, "unknown user": unknownUser} {
		if err != auth.ErrInvalidCredentials { //nolint:errorlint // the very same value, so nothing tells them apart
			t.Errorf("%s: err = %v, want exactly ErrInvalidCredentials", name, err)
		}
	}
	// A code with a wrong password is not spent: it still works with the right one.
	if err := login(svc, "correct horse", codeAt(clk)); err != nil {
		t.Fatalf("the code was used up by a login with the wrong password: %v", err)
	}
}

func TestLoginWithRecoveryCode(t *testing.T) {
	svc, st, _ := newService(t)
	codes := withTOTP(t, st)
	// A wrong password does not use the recovery code up.
	if err := login(svc, "wrong password", codes[0]); !errors.Is(err, auth.ErrInvalidCredentials) {
		t.Fatalf("err = %v", err)
	}
	if err := login(svc, "correct horse", codes[0]); err != nil {
		t.Fatalf("unused recovery code: %v", err)
	}
	if err := login(svc, "correct horse", codes[0]); !errors.Is(err, auth.ErrInvalidCredentials) {
		t.Fatalf("used recovery code: err = %v", err)
	}
	// Typed loosely: upper case, no dash.
	loose := codes[1][:5] + codes[1][6:]
	if err := login(svc, "correct horse", " "+toUpper(loose)+" "); err != nil {
		t.Fatalf("recovery code typed without the dash, in capitals: %v", err)
	}
	if err := login(svc, "correct horse", "abcde-fghjk"); !errors.Is(err, auth.ErrInvalidCredentials) {
		t.Fatalf("made-up recovery code: err = %v", err)
	}
}

func toUpper(s string) string {
	b := []byte(s)
	for i, c := range b {
		if c >= 'a' && c <= 'z' {
			b[i] = c - 'a' + 'A'
		}
	}
	return string(b)
}

// Wrong codes, and logins that stop at "code required", spend the same
// per-username budget as wrong passwords; a full login gives it back.
func TestSecondFactorFailuresCountTowardLockout(t *testing.T) {
	svc, st, clk := newService(t)
	withTOTP(t, st)
	_ = login(svc, "correct horse", "")
	_ = login(svc, "correct horse", "")
	_ = login(svc, "correct horse", "000000")
	_ = login(svc, "correct horse", "111111")
	_ = login(svc, "correct horse", "abcde-fghjk")
	if err := login(svc, "correct horse", codeAt(clk)); !errors.Is(err, auth.ErrRateLimited) {
		t.Fatalf("sixth attempt: err = %v, want rate limited even with both factors right", err)
	}
	clk.Advance(time.Minute)
	if err := login(svc, "correct horse", codeAt(clk)); err != nil {
		t.Fatalf("after refill: %v", err)
	}
	// The success reset the budget: five more failures are allowed again.
	for i := 0; i < 4; i++ {
		_ = login(svc, "correct horse", "")
	}
	clk.Advance(30 * time.Second)
	if err := login(svc, "correct horse", codeAt(clk)); err != nil {
		t.Fatalf("budget was not reset by the successful login: %v", err)
	}
}

// Turning TOTP on or off leaves existing device tokens working.
func TestTOTPLeavesDeviceTokensAlone(t *testing.T) {
	svc, st, _ := newService(t)
	res, err := svc.Login(ctx, auth.LoginRequest{Username: "alice", Password: "correct horse"})
	if err != nil {
		t.Fatal(err)
	}
	withTOTP(t, st)
	if _, err := svc.Authenticate(ctx, res.Token); err != nil {
		t.Fatalf("token after enabling TOTP: %v", err)
	}
	if err := st.DisableTOTP(ctx, res.Device.UserID); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Authenticate(ctx, res.Token); err != nil {
		t.Fatalf("token after disabling TOTP: %v", err)
	}
	if err := login(svc, "correct horse", ""); err != nil {
		t.Fatalf("login after disabling TOTP: %v", err)
	}
}
