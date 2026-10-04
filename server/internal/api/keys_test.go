package api_test

import (
	"net/http"
	"strings"
	"testing"

	"google.golang.org/protobuf/proto"

	"github.com/jfms7s/obsidian-sync/server/internal/apperr"
	obsyncv1 "github.com/jfms7s/obsidian-sync/server/internal/gen/obsync/v1"
)

// replacement is validBundle with new wrapped private keys, as after a
// passphrase change, authorized by password.
func replacement(password string) *obsyncv1.KeyBundle {
	kb := validBundle()
	kb.PassWrapped = []byte("rewrapped-by-new-passphrase")
	kb.RecoveryWrapped = []byte("rewrapped-by-recovery-key")
	kb.CurrentPassword = password
	return kb
}

// keysEnv logs alice in and uploads her first bundle.
func keysEnv(t *testing.T) (*testEnv, string) {
	t.Helper()
	e := newTestEnv(t)
	e.createUser("Alice", "correct horse")
	token, _ := e.login("alice", "correct horse")
	if status, apiErr := e.do("PUT", "/v1/keys", token, validBundle(), nil); status != http.StatusNoContent {
		t.Fatalf("first upload without a password = %d %v", status, apiErr)
	}
	return e, token
}

func (e *testEnv) wantStoredBundle(token string, want *obsyncv1.KeyBundle) {
	e.t.Helper()
	var got obsyncv1.KeyBundle
	if status, apiErr := e.do("GET", "/v1/keys", token, nil, &got); status != 200 {
		e.t.Fatalf("get = %d %v", status, apiErr)
	}
	if !proto.Equal(&got, want) {
		e.t.Fatalf("stored bundle = %v, want %v", &got, want)
	}
}

func TestFirstKeyUploadNeedsNoPassword(t *testing.T) {
	e, token := keysEnv(t)
	e.wantStoredBundle(token, validBundle())
}

func TestReplacingKeysWithoutPasswordIsRejected(t *testing.T) {
	e, token := keysEnv(t)
	status, apiErr := e.do("PUT", "/v1/keys", token, replacement(""), nil)
	wantErr(t, status, apiErr, http.StatusForbidden, apperr.WrongPassword)
	e.wantStoredBundle(token, validBundle())

	// Even resending the identical bundle needs the password.
	status, apiErr = e.do("PUT", "/v1/keys", token, validBundle(), nil)
	wantErr(t, status, apiErr, http.StatusForbidden, apperr.WrongPassword)
}

func TestReplacingKeysWithWrongPasswordIsRejectedAndCounted(t *testing.T) {
	e, token := keysEnv(t)
	status, apiErr := e.do("PUT", "/v1/keys", token, replacement("guess"), nil)
	wantErr(t, status, apiErr, http.StatusForbidden, apperr.WrongPassword)
	e.wantStoredBundle(token, validBundle())

	// The wrong guess spent one of the 5 login attempts: 4 more wrong
	// logins exhaust the budget, and then even the right password is
	// refused, by login and by PUT /v1/keys alike.
	for i := 0; i < 4; i++ {
		status, apiErr := e.do("POST", "/v1/auth/login", "", &obsyncv1.LoginRequest{Username: "alice", Password: "guess"}, nil)
		wantErr(t, status, apiErr, http.StatusUnauthorized, apperr.Unauthorized)
	}
	status, apiErr = e.do("POST", "/v1/auth/login", "", &obsyncv1.LoginRequest{Username: "alice", Password: "correct horse"}, nil)
	wantErr(t, status, apiErr, http.StatusTooManyRequests, apperr.RateLimited)
	status, apiErr = e.do("PUT", "/v1/keys", token, replacement("correct horse"), nil)
	wantErr(t, status, apiErr, http.StatusTooManyRequests, apperr.RateLimited)
	e.wantStoredBundle(token, validBundle())
}

func TestFailedLoginsLimitKeyReplacement(t *testing.T) {
	e, token := keysEnv(t)
	for i := 0; i < 5; i++ {
		_, _ = e.do("POST", "/v1/auth/login", "", &obsyncv1.LoginRequest{Username: "ALICE", Password: "guess"}, nil)
	}
	status, apiErr := e.do("PUT", "/v1/keys", token, replacement("correct horse"), nil)
	wantErr(t, status, apiErr, http.StatusTooManyRequests, apperr.RateLimited)
	e.wantStoredBundle(token, validBundle())
}

func TestReplacingKeysWithRightPassword(t *testing.T) {
	e, token := keysEnv(t)
	if status, apiErr := e.do("PUT", "/v1/keys", token, replacement("correct horse"), nil); status != http.StatusNoContent {
		t.Fatalf("replace = %d %v", status, apiErr)
	}
	// The password is never stored or echoed back.
	want := replacement("")
	e.wantStoredBundle(token, want)

	// Public keys stay pinned even with the right password.
	changed := replacement("correct horse")
	changed.PublicSignKey = changed.PublicEncKey
	status, apiErr := e.do("PUT", "/v1/keys", token, changed, nil)
	wantErr(t, status, apiErr, http.StatusBadRequest, apperr.Invalid)
	e.wantStoredBundle(token, want)
}

func TestKeyReplacementPasswordIsCapped(t *testing.T) {
	e, token := keysEnv(t)
	status, apiErr := e.do("PUT", "/v1/keys", token, replacement(strings.Repeat("x", 1025)), nil)
	wantErr(t, status, apiErr, http.StatusBadRequest, apperr.Invalid)
}

// A device of another user is unaffected: its first upload needs no password.
func TestKeyBundlesArePerUser(t *testing.T) {
	e, _ := keysEnv(t)
	e.createUser("bob", "battery staple")
	bob, _ := e.login("bob", "battery staple")
	if status, apiErr := e.do("PUT", "/v1/keys", bob, validBundle(), nil); status != http.StatusNoContent {
		t.Fatalf("bob's first upload = %d %v", status, apiErr)
	}
}
