package api_test

import (
	"encoding/base32"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/jfms7s/obsidian-sync/server/internal/apperr"
	"github.com/jfms7s/obsidian-sync/server/internal/auth"
	obsyncv1 "github.com/jfms7s/obsidian-sync/server/internal/gen/obsync/v1"
)

func (e *testEnv) totpStatus(token string) *obsyncv1.TotpStatusResponse {
	e.t.Helper()
	var st obsyncv1.TotpStatusResponse
	if status, apiErr := e.do("GET", "/v1/account/totp", token, nil, &st); status != http.StatusOK {
		e.t.Fatalf("totp status = %d %v", status, apiErr)
	}
	return &st
}

func codeFor(t *testing.T, secretText string, now time.Time) string {
	t.Helper()
	secret, err := base32.StdEncoding.WithPadding(base32.NoPadding).DecodeString(secretText)
	if err != nil {
		t.Fatalf("secret %q: %v", secretText, err)
	}
	return auth.TOTPCode(secret, auth.TOTPStep(now))
}

func TestTOTPEnrolmentFlow(t *testing.T) {
	e := newTestEnv(t)
	e.createUser("alice", "correct horse")
	token, _ := e.login("alice", "correct horse")
	if st := e.totpStatus(token); st.Enabled || st.RecoveryCodesLeft != 0 {
		t.Fatalf("status = %v", st)
	}

	// Begin needs the account password.
	status, apiErr := e.do("POST", "/v1/account/totp/begin", token, &obsyncv1.TotpBeginRequest{}, nil)
	wantErr(t, status, apiErr, http.StatusForbidden, apperr.WrongPassword)
	status, apiErr = e.do("POST", "/v1/account/totp/begin", token, &obsyncv1.TotpBeginRequest{CurrentPassword: "nope"}, nil)
	wantErr(t, status, apiErr, http.StatusForbidden, apperr.WrongPassword)
	var begin obsyncv1.TotpBeginResponse
	if status, apiErr := e.do("POST", "/v1/account/totp/begin", token, &obsyncv1.TotpBeginRequest{CurrentPassword: "correct horse"}, &begin); status != http.StatusOK {
		t.Fatalf("begin = %d %v", status, apiErr)
	}
	if len(begin.Secret) != 32 || !strings.HasPrefix(begin.OtpauthUri, "otpauth://totp/obsync:alice?") || !strings.Contains(begin.OtpauthUri, "secret="+begin.Secret) {
		t.Fatalf("begin = %v", &begin)
	}
	if e.totpStatus(token).Enabled {
		t.Fatal("TOTP is on before it was confirmed")
	}

	// A wrong code leaves it off; the right one turns it on and returns the recovery codes.
	status, apiErr = e.do("POST", "/v1/account/totp/confirm", token, &obsyncv1.TotpConfirmRequest{Code: "000000"}, nil)
	wantErr(t, status, apiErr, http.StatusForbidden, apperr.WrongPassword)
	if e.totpStatus(token).Enabled {
		t.Fatal("a wrong code turned TOTP on")
	}
	var codes obsyncv1.TotpRecoveryCodesResponse
	if status, apiErr := e.do("POST", "/v1/account/totp/confirm", token, &obsyncv1.TotpConfirmRequest{Code: codeFor(t, begin.Secret, e.clk.Now())}, &codes); status != http.StatusOK {
		t.Fatalf("confirm = %d %v", status, apiErr)
	}
	if len(codes.RecoveryCodes) != 10 {
		t.Fatalf("recovery codes = %v", codes.RecoveryCodes)
	}
	if st := e.totpStatus(token); !st.Enabled || st.RecoveryCodesLeft != 10 {
		t.Fatalf("status = %v", st)
	}
	// Confirming again, or beginning again, is refused while it is on.
	status, apiErr = e.do("POST", "/v1/account/totp/confirm", token, &obsyncv1.TotpConfirmRequest{Code: codeFor(t, begin.Secret, e.clk.Now())}, nil)
	wantErr(t, status, apiErr, http.StatusBadRequest, apperr.Invalid)
	status, apiErr = e.do("POST", "/v1/account/totp/begin", token, &obsyncv1.TotpBeginRequest{CurrentPassword: "correct horse"}, nil)
	wantErr(t, status, apiErr, http.StatusBadRequest, apperr.Invalid)

	// Logins now need a code; a recovery code does once.
	status, apiErr = e.do("POST", "/v1/auth/login", "", &obsyncv1.LoginRequest{Username: "alice", Password: "correct horse"}, nil)
	wantErr(t, status, apiErr, http.StatusUnauthorized, apperr.SecondFactorRequired)
	if status, apiErr := e.do("POST", "/v1/auth/login", "", &obsyncv1.LoginRequest{Username: "alice", Password: "correct horse", TotpCode: codes.RecoveryCodes[0]}, nil); status != http.StatusOK {
		t.Fatalf("login with a recovery code = %d %v", status, apiErr)
	}
	if st := e.totpStatus(token); st.RecoveryCodesLeft != 9 {
		t.Fatalf("recovery codes left = %d", st.RecoveryCodesLeft)
	}

	// New recovery codes need the password and a code; the old ones stop working.
	e.clk.Advance(30 * time.Second)
	status, apiErr = e.do("POST", "/v1/account/totp/recovery-codes", token, &obsyncv1.TotpVerifyRequest{CurrentPassword: "correct horse", Code: "000000"}, nil)
	wantErr(t, status, apiErr, http.StatusForbidden, apperr.WrongPassword)
	var fresh obsyncv1.TotpRecoveryCodesResponse
	if status, apiErr := e.do("POST", "/v1/account/totp/recovery-codes", token, &obsyncv1.TotpVerifyRequest{
		CurrentPassword: "correct horse", Code: codeFor(t, begin.Secret, e.clk.Now()),
	}, &fresh); status != http.StatusOK || len(fresh.RecoveryCodes) != 10 {
		t.Fatalf("new recovery codes = %d %v %v", status, apiErr, fresh.RecoveryCodes)
	}
	status, apiErr = e.do("POST", "/v1/auth/login", "", &obsyncv1.LoginRequest{Username: "alice", Password: "correct horse", TotpCode: codes.RecoveryCodes[1]}, nil)
	wantErr(t, status, apiErr, http.StatusUnauthorized, apperr.Unauthorized)

	// Disable needs the password and a code (or a recovery code).
	e.clk.Advance(30 * time.Second)
	status, apiErr = e.do("POST", "/v1/account/totp/disable", token, &obsyncv1.TotpVerifyRequest{CurrentPassword: "nope", Code: codeFor(t, begin.Secret, e.clk.Now())}, nil)
	wantErr(t, status, apiErr, http.StatusForbidden, apperr.WrongPassword)
	status, apiErr = e.do("POST", "/v1/account/totp/disable", token, &obsyncv1.TotpVerifyRequest{CurrentPassword: "correct horse"}, nil)
	wantErr(t, status, apiErr, http.StatusForbidden, apperr.WrongPassword)
	if !e.totpStatus(token).Enabled {
		t.Fatal("a refused disable turned TOTP off")
	}
	if status, apiErr := e.do("POST", "/v1/account/totp/disable", token, &obsyncv1.TotpVerifyRequest{CurrentPassword: "correct horse", Code: fresh.RecoveryCodes[3]}, nil); status != http.StatusNoContent {
		t.Fatalf("disable = %d %v", status, apiErr)
	}
	if e.totpStatus(token).Enabled {
		t.Fatal("still on after disable")
	}
	e.login("alice", "correct horse") // no code needed any more
	status, apiErr = e.do("POST", "/v1/account/totp/disable", token, &obsyncv1.TotpVerifyRequest{CurrentPassword: "correct horse", Code: "123456"}, nil)
	wantErr(t, status, apiErr, http.StatusBadRequest, apperr.Invalid)
	// The device signed in at the start was never signed out.
	if status, apiErr := e.do("GET", "/v1/devices", token, nil, nil); status != http.StatusOK {
		t.Fatalf("original token = %d %v", status, apiErr)
	}
}

func TestTOTPRoutesNeedADeviceToken(t *testing.T) {
	e := newTestEnv(t)
	for _, r := range []struct{ method, path string }{
		{"GET", "/v1/account/totp"}, {"POST", "/v1/account/totp/begin"}, {"POST", "/v1/account/totp/confirm"},
		{"POST", "/v1/account/totp/disable"}, {"POST", "/v1/account/totp/recovery-codes"},
	} {
		status, apiErr := e.do(r.method, r.path, "", nil, nil)
		wantErr(t, status, apiErr, http.StatusUnauthorized, apperr.Unauthorized)
	}
}

// Wrong codes at confirm, and wrong passwords or codes at disable, spend the
// same per-username budget as logins.
func TestTOTPGuessesAreRateLimited(t *testing.T) {
	e := newTestEnv(t)
	e.createUser("alice", "correct horse")
	token, _ := e.login("alice", "correct horse")
	var begin obsyncv1.TotpBeginResponse
	e.do("POST", "/v1/account/totp/begin", token, &obsyncv1.TotpBeginRequest{CurrentPassword: "correct horse"}, &begin)
	for i := 0; i < 4; i++ {
		e.do("POST", "/v1/account/totp/confirm", token, &obsyncv1.TotpConfirmRequest{Code: "000000"}, nil)
	}
	// The begin above reset the budget; four wrong codes and this right one.
	var codes obsyncv1.TotpRecoveryCodesResponse
	if status, apiErr := e.do("POST", "/v1/account/totp/confirm", token, &obsyncv1.TotpConfirmRequest{Code: codeFor(t, begin.Secret, e.clk.Now())}, &codes); status != http.StatusOK {
		t.Fatalf("confirm within the budget = %d %v", status, apiErr)
	}
	for i := 0; i < 5; i++ {
		e.do("POST", "/v1/account/totp/disable", token, &obsyncv1.TotpVerifyRequest{CurrentPassword: "correct horse", Code: "000000"}, nil)
	}
	status, apiErr := e.do("POST", "/v1/account/totp/disable", token, &obsyncv1.TotpVerifyRequest{CurrentPassword: "correct horse", Code: codes.RecoveryCodes[0]}, nil)
	wantErr(t, status, apiErr, http.StatusTooManyRequests, apperr.RateLimited)
	// Logins share it.
	status, apiErr = e.do("POST", "/v1/auth/login", "", &obsyncv1.LoginRequest{Username: "alice", Password: "correct horse", TotpCode: codes.RecoveryCodes[0]}, nil)
	wantErr(t, status, apiErr, http.StatusTooManyRequests, apperr.RateLimited)
	if !e.totpStatus(token).Enabled {
		t.Fatal("TOTP went off")
	}
}

// A second begin replaces the first secret: codes from the first no longer
// confirm.
func TestTOTPBeginAgainReplacesThePendingSecret(t *testing.T) {
	e := newTestEnv(t)
	e.createUser("alice", "correct horse")
	token, _ := e.login("alice", "correct horse")
	var first, second obsyncv1.TotpBeginResponse
	e.do("POST", "/v1/account/totp/begin", token, &obsyncv1.TotpBeginRequest{CurrentPassword: "correct horse"}, &first)
	e.do("POST", "/v1/account/totp/begin", token, &obsyncv1.TotpBeginRequest{CurrentPassword: "correct horse"}, &second)
	if first.Secret == second.Secret {
		t.Fatal("begin returned the same secret twice")
	}
	status, apiErr := e.do("POST", "/v1/account/totp/confirm", token, &obsyncv1.TotpConfirmRequest{Code: codeFor(t, first.Secret, e.clk.Now())}, nil)
	wantErr(t, status, apiErr, http.StatusForbidden, apperr.WrongPassword)
	if status, apiErr := e.do("POST", "/v1/account/totp/confirm", token, &obsyncv1.TotpConfirmRequest{Code: codeFor(t, second.Secret, e.clk.Now())}, nil); status != http.StatusOK {
		t.Fatalf("confirm with the second secret = %d %v", status, apiErr)
	}
	// Confirm without a begin.
	e.createUser("bob", "battery staple")
	bobTok, _ := e.login("bob", "battery staple")
	status, apiErr = e.do("POST", "/v1/account/totp/confirm", bobTok, &obsyncv1.TotpConfirmRequest{Code: "123456"}, nil)
	wantErr(t, status, apiErr, http.StatusBadRequest, apperr.Invalid)
}

// A set-up not confirmed within ten minutes expires: a device token alone
// cannot keep guessing codes for a secret someone started and abandoned.
func TestTOTPSetUpExpires(t *testing.T) {
	e := newTestEnv(t)
	e.createUser("alice", "correct horse")
	token, _ := e.login("alice", "correct horse")
	var begin obsyncv1.TotpBeginResponse
	e.do("POST", "/v1/account/totp/begin", token, &obsyncv1.TotpBeginRequest{CurrentPassword: "correct horse"}, &begin)
	e.clk.Advance(10*time.Minute + time.Second)
	status, apiErr := e.do("POST", "/v1/account/totp/confirm", token, &obsyncv1.TotpConfirmRequest{Code: codeFor(t, begin.Secret, e.clk.Now())}, nil)
	wantErr(t, status, apiErr, http.StatusBadRequest, apperr.Invalid)
	if !strings.Contains(apiErr.Message, "expired") {
		t.Fatalf("message = %q", apiErr.Message)
	}
	if e.totpStatus(token).Enabled {
		t.Fatal("an expired set-up turned TOTP on")
	}
	// Starting again works.
	e.do("POST", "/v1/account/totp/begin", token, &obsyncv1.TotpBeginRequest{CurrentPassword: "correct horse"}, &begin)
	e.clk.Advance(9 * time.Minute)
	if status, apiErr := e.do("POST", "/v1/account/totp/confirm", token, &obsyncv1.TotpConfirmRequest{Code: codeFor(t, begin.Secret, e.clk.Now())}, nil); status != http.StatusOK {
		t.Fatalf("confirm within ten minutes = %d %v", status, apiErr)
	}
}
