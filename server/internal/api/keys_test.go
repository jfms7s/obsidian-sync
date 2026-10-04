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

	// Any difference from the stored bundle needs the password, however
	// small: here only the KDF parameters change.
	kb := validBundle()
	kb.PassParams.Iterations++
	status, apiErr = e.do("PUT", "/v1/keys", token, kb, nil)
	wantErr(t, status, apiErr, http.StatusForbidden, apperr.WrongPassword)
	e.wantStoredBundle(token, validBundle())
}

// A client retrying a first upload whose response was lost resends the very
// bundle already stored. That changes nothing, so it succeeds without the
// password, and without spending a password attempt even when one is sent.
func TestResendingIdenticalKeyBundleIsIdempotent(t *testing.T) {
	e, token := keysEnv(t)
	if status, apiErr := e.do("PUT", "/v1/keys", token, validBundle(), nil); status != http.StatusNoContent {
		t.Fatalf("identical resend without a password = %d %v", status, apiErr)
	}
	// Wrong passwords on identical resends are never checked: 5 of them
	// would otherwise exhaust alice's login budget.
	for i := 0; i < 5; i++ {
		kb := validBundle()
		kb.CurrentPassword = "guess"
		if status, apiErr := e.do("PUT", "/v1/keys", token, kb, nil); status != http.StatusNoContent {
			t.Fatalf("identical resend %d = %d %v", i, status, apiErr)
		}
	}
	for i := 0; i < 4; i++ {
		status, apiErr := e.do("POST", "/v1/auth/login", "", &obsyncv1.LoginRequest{Username: "alice", Password: "guess"}, nil)
		wantErr(t, status, apiErr, http.StatusUnauthorized, apperr.Unauthorized)
	}
	e.login("alice", "correct horse") // fails the test if rate limited
	e.wantStoredBundle(token, validBundle())
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
