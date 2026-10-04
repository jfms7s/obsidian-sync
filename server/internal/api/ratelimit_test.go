package api_test

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"sync/atomic"
	"testing"
	"time"

	"google.golang.org/protobuf/proto"

	"github.com/jfms7s/obsidian-sync/server/internal/api"
	"github.com/jfms7s/obsidian-sync/server/internal/apperr"
	obsyncv1 "github.com/jfms7s/obsidian-sync/server/internal/gen/obsync/v1"
)

// serve sends a request straight to the handler from remoteAddr, so tests
// can choose the client address and X-Forwarded-For.
func (e *testEnv) serve(method, path, token, remoteAddr string, xff ...string) *httptest.ResponseRecorder {
	e.t.Helper()
	var body []byte
	if method == "POST" {
		body, _ = proto.Marshal(&obsyncv1.LoginRequest{Username: "nobody", Password: "x"})
	}
	r := httptest.NewRequest(method, path, bytes.NewReader(body))
	r.RemoteAddr = remoteAddr
	r.Header.Set("Content-Type", "application/x-protobuf")
	if token != "" {
		r.Header.Set("Authorization", "Bearer "+token)
	}
	for _, v := range xff {
		r.Header.Add("X-Forwarded-For", v)
	}
	w := httptest.NewRecorder()
	e.handler.ServeHTTP(w, r)
	return w
}

// wantLimited checks a 429 RATE_LIMITED reply carrying Retry-After.
func wantLimited(t *testing.T, w *httptest.ResponseRecorder, retryAfter string) {
	t.Helper()
	if w.Code != http.StatusTooManyRequests {
		t.Fatalf("status = %d, want 429 (body %q)", w.Code, w.Body.Bytes())
	}
	var apiErr obsyncv1.Error
	if err := proto.Unmarshal(w.Body.Bytes(), &apiErr); err != nil || apiErr.Code != apperr.RateLimited {
		t.Fatalf("body = %v (%v), want RATE_LIMITED", &apiErr, err)
	}
	if got := w.Header().Get("Retry-After"); got != retryAfter {
		t.Fatalf("Retry-After = %q, want %q", got, retryAfter)
	}
}

func notLimited(t *testing.T, w *httptest.ResponseRecorder) {
	t.Helper()
	if w.Code == http.StatusTooManyRequests {
		t.Fatalf("unexpected 429: %q", w.Body.Bytes())
	}
}

const client1 = "198.51.100.7:4000"

// Every authenticated route, chunk transfer and commit included, draws on one
// bucket per device; another device has its own.
func TestDeviceRateLimit(t *testing.T) {
	e := newTestEnvLimited(t, api.RateLimits{DeviceRPS: 0.4, DeviceBurst: 3}, nil)
	e.createUser("alice", "correct horse")
	laptop, _ := e.login("alice", "correct horse")
	phone, _ := e.login("alice", "correct horse")
	vault := "/v1/vaults/0123456789abcdef0123456789abcdef"
	for _, path := range []string{"/v1/devices", vault + "/chunks/" + string(bytes.Repeat([]byte("a"), 64)), "/v1/keys"} {
		notLimited(t, e.serve("GET", path, laptop, client1))
	}
	// 0.4 req/s: the next token is 2.5s away, rounded up to 3.
	wantLimited(t, e.serve("POST", vault+"/commit", laptop, client1), "3")
	wantLimited(t, e.serve("GET", "/v1/devices", laptop, "203.0.113.1:1"), "3")
	notLimited(t, e.serve("GET", "/v1/devices", phone, client1))

	e.clk.Advance(2500 * time.Millisecond)
	if w := e.serve("GET", "/v1/devices", laptop, client1); w.Code != 200 {
		t.Fatalf("after refill: %d", w.Code)
	}
	wantLimited(t, e.serve("GET", "/v1/devices", laptop, client1), "3")
}

func TestLoginIPRateLimit(t *testing.T) {
	e := newTestEnvLimited(t, api.RateLimits{IPRPS: 1, IPBurst: 2}, nil)
	for i := 0; i < 2; i++ {
		if w := e.serve("POST", "/v1/auth/login", "", client1); w.Code != 401 {
			t.Fatalf("login %d = %d", i, w.Code)
		}
	}
	wantLimited(t, e.serve("POST", "/v1/auth/login", "", client1), "1")
	notLimited(t, e.serve("POST", "/v1/auth/login", "", "198.51.100.8:4000"))
	e.clk.Advance(time.Second)
	notLimited(t, e.serve("POST", "/v1/auth/login", "", client1))
}

func TestHealthIsExempt(t *testing.T) {
	e := newTestEnvLimited(t, api.RateLimits{IPRPS: 0.01, IPBurst: 1, DeviceRPS: 0.01, DeviceBurst: 1}, nil)
	e.serve("POST", "/v1/auth/login", "", client1)
	wantLimited(t, e.serve("POST", "/v1/auth/login", "", client1), "100")
	for i := 0; i < 20; i++ {
		for _, path := range []string{"/healthz", "/readyz"} {
			if w := e.serve("GET", path, "", client1); w.Code != 200 {
				t.Fatalf("%s = %d", path, w.Code)
			}
		}
	}
}

// Requests with a missing, unknown or revoked token draw on a per-IP budget
// checked before the token is looked up; valid tokens do not touch it.
func TestInvalidTokenThrottledPerIP(t *testing.T) {
	e := newTestEnvLimited(t, api.RateLimits{IPRPS: 1, IPBurst: 3}, nil)
	e.createUser("alice", "correct horse")
	token, _ := e.login("alice", "correct horse")

	// Valid tokens never spend the failed-auth budget.
	for i := 0; i < 10; i++ {
		if w := e.serve("GET", "/v1/devices", token, client1); w.Code != 200 {
			t.Fatalf("valid request %d = %d", i, w.Code)
		}
	}
	for _, tok := range []string{"guess-1", "", "guess-2"} {
		if w := e.serve("GET", "/v1/devices", tok, client1); w.Code != 401 {
			t.Fatalf("bad token %q = %d", tok, w.Code)
		}
	}
	wantLimited(t, e.serve("GET", "/v1/devices", "guess-3", client1), "1")
	// Blocked before lookup: even a valid token from that address waits.
	wantLimited(t, e.serve("GET", "/v1/devices", token, client1), "1")
	// Other addresses are unaffected.
	if w := e.serve("GET", "/v1/devices", "guess-4", "198.51.100.9:1"); w.Code != 401 {
		t.Fatalf("other IP = %d", w.Code)
	}
	if w := e.serve("GET", "/v1/devices", token, "198.51.100.9:1"); w.Code != 200 {
		t.Fatalf("other IP valid = %d", w.Code)
	}
	// The login budget is separate from the failed-token budget.
	notLimited(t, e.serve("POST", "/v1/auth/login", "", client1))
	e.clk.Advance(time.Second)
	if w := e.serve("GET", "/v1/devices", token, client1); w.Code != 200 {
		t.Fatalf("after refill = %d", w.Code)
	}
}

func TestWebSocketUpgradeCountsAgainstIP(t *testing.T) {
	var calls atomic.Int32
	hub := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls.Add(1) })
	e := newTestEnvLimited(t, api.RateLimits{IPRPS: 1, IPBurst: 2}, hub)
	e.serve("GET", "/v1/ws", "", client1)
	e.serve("POST", "/v1/auth/login", "", client1) // shares the unauthenticated budget
	wantLimited(t, e.serve("GET", "/v1/ws", "", client1), "1")
	if n := calls.Load(); n != 1 {
		t.Fatalf("hub reached %d times, want 1", n)
	}
}

func TestTrustedProxyKeying(t *testing.T) {
	e := newTestEnvLimited(t, api.RateLimits{IPRPS: 1, IPBurst: 1,
		TrustedProxies: []netip.Prefix{netip.MustParsePrefix("10.0.0.0/8")}}, nil)
	proxy := "10.0.0.2:5555"
	notLimited(t, e.serve("POST", "/v1/auth/login", "", proxy, "198.51.100.1"))
	wantLimited(t, e.serve("POST", "/v1/auth/login", "", proxy, "198.51.100.1"), "1")
	// A spoofed left-most entry does not change the key.
	wantLimited(t, e.serve("POST", "/v1/auth/login", "", proxy, "6.6.6.6, 198.51.100.1"), "1")
	notLimited(t, e.serve("POST", "/v1/auth/login", "", proxy, "198.51.100.2"))

	// From an untrusted peer, X-Forwarded-For is ignored.
	notLimited(t, e.serve("POST", "/v1/auth/login", "", "203.0.113.9:1", "1.1.1.1"))
	wantLimited(t, e.serve("POST", "/v1/auth/login", "", "203.0.113.9:1", "2.2.2.2"), "1")

	// One IPv6 /64 is one client.
	notLimited(t, e.serve("POST", "/v1/auth/login", "", "[2001:db8:0:1::1]:1"))
	wantLimited(t, e.serve("POST", "/v1/auth/login", "", "[2001:db8:0:1::2]:1"), "1")
	notLimited(t, e.serve("POST", "/v1/auth/login", "", "[2001:db8:0:2::1]:1"))
}

// With no limits configured (the zero RateLimits) nothing is throttled.
func TestRateLimitsDisabledByDefault(t *testing.T) {
	e := newTestEnv(t)
	for i := 0; i < 50; i++ {
		notLimited(t, e.serve("GET", "/v1/devices", "bad", client1))
	}
	// (Fewer logins: the per-username login limiter still applies.)
	for i := 0; i < 4; i++ {
		notLimited(t, e.serve("POST", "/v1/auth/login", "", client1))
	}
}
