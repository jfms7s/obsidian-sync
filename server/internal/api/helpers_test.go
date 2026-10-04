package api_test

import (
	"bytes"
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"google.golang.org/protobuf/proto"

	"github.com/jfms7s/obsidian-sync/server/internal/api"
	"github.com/jfms7s/obsidian-sync/server/internal/auth"
	"github.com/jfms7s/obsidian-sync/server/internal/blob"
	"github.com/jfms7s/obsidian-sync/server/internal/bus"
	obsyncv1 "github.com/jfms7s/obsidian-sync/server/internal/gen/obsync/v1"
	"github.com/jfms7s/obsidian-sync/server/internal/ids"
	"github.com/jfms7s/obsidian-sync/server/internal/store"
	"github.com/jfms7s/obsidian-sync/server/internal/store/storetest"
	"github.com/jfms7s/obsidian-sync/server/internal/syncsvc"
)

var ctx = context.Background()

type testEnv struct {
	t        *testing.T
	url      string
	st       *store.Store
	blobRoot string
	// failBlobReads makes every blob read return a few bytes and then an
	// error, simulating storage failing mid-download.
	failBlobReads *atomic.Bool
	// handler is the API handler, for tests that serve it themselves.
	handler http.Handler
	clk     *storetest.Clock
}

// faultyBlobs wraps a blob store so tests can make reads fail mid-stream.
type faultyBlobs struct {
	blob.Store
	fail *atomic.Bool
}

func (f faultyBlobs) Get(ctx context.Context, key string) (io.ReadCloser, error) {
	rc, err := f.Store.Get(ctx, key)
	if err != nil || !f.fail.Load() {
		return rc, err
	}
	return &failingReader{rc: rc, left: 3}, nil
}

// failingReader passes through left bytes, then fails.
type failingReader struct {
	rc   io.ReadCloser
	left int
}

func (r *failingReader) Read(p []byte) (int, error) {
	if r.left == 0 {
		return 0, errors.New("injected blob read failure")
	}
	if len(p) > r.left {
		p = p[:r.left]
	}
	n, err := r.rc.Read(p)
	r.left -= n
	return n, err
}

func (r *failingReader) Close() error { return r.rc.Close() }

func newTestEnv(t *testing.T) *testEnv {
	t.Helper()
	return newTestEnvWrapped(t, nil)
}

// newTestEnvWrapped is newTestEnv with the API handler's store replaced by
// wrap(store), so a test can inject store behaviour; a nil wrap uses the store.
func newTestEnvWrapped(t *testing.T, wrap func(*store.Store) api.Store) *testEnv {
	t.Helper()
	return newTestEnvFull(t, wrap, api.RateLimits{}, nil)
}

// newTestEnvLimited is newTestEnv with request rate limiting configured; the
// limiters run on the test clock unless rl.Now is set. hub, if not nil, is
// served at /v1/ws.
func newTestEnvLimited(t *testing.T, rl api.RateLimits, hub http.Handler) *testEnv {
	t.Helper()
	return newTestEnvFull(t, nil, rl, hub)
}

func newTestEnvFull(t *testing.T, wrap func(*store.Store) api.Store, rl api.RateLimits, hub http.Handler) *testEnv {
	t.Helper()
	st, clk := storetest.New(t)
	if rl.Now == nil {
		rl.Now = clk.Now
	}
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	authSvc, err := auth.NewService(st, auth.Options{Params: auth.FastParams, Now: clk.Now})
	if err != nil {
		t.Fatal(err)
	}
	blobRoot := t.TempDir()
	blobs, err := blob.NewFS(blobRoot)
	if err != nil {
		t.Fatal(err)
	}
	failBlobReads := new(atomic.Bool)
	syncSvc := syncsvc.New(st, faultyBlobs{Store: blobs, fail: failBlobReads}, bus.NewMemory(), syncsvc.Limits{MaxFileSizeBytes: 64 << 20}, log)
	var apiStore api.Store = st
	if wrap != nil {
		apiStore = wrap(st)
	}
	h := api.NewHandler(api.Deps{Auth: authSvc, Sync: syncSvc, Store: apiStore, Hub: hub, Ready: st.Ping, Log: log, RateLimits: rl})
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	return &testEnv{t: t, url: srv.URL, st: st, blobRoot: blobRoot, failBlobReads: failBlobReads, handler: h, clk: clk}
}

func (e *testEnv) createUser(username, password string) store.User {
	e.t.Helper()
	hash, err := auth.HashPassword(password, auth.FastParams)
	if err != nil {
		e.t.Fatal(err)
	}
	u := store.User{ID: ids.New(), Username: username, PasswordHash: hash, QuotaBytes: 1 << 30}
	if err := e.st.CreateUser(ctx, u); err != nil {
		e.t.Fatal(err)
	}
	return u
}

// login returns a fresh device token for username.
func (e *testEnv) login(username, password string) (token, deviceID string) {
	e.t.Helper()
	var resp obsyncv1.LoginResponse
	status, apiErr := e.do("POST", "/v1/auth/login", "", &obsyncv1.LoginRequest{
		Username: username, Password: password, DeviceName: "laptop", Platform: "linux",
	}, &resp)
	if status != http.StatusOK {
		e.t.Fatalf("login: %d %v", status, apiErr)
	}
	return resp.Token, resp.DeviceId
}

// do sends a protobuf request (in may be nil) and decodes a 2xx response into
// out (may be nil) or an error response into the returned *obsyncv1.Error.
func (e *testEnv) do(method, path, token string, in, out proto.Message) (int, *obsyncv1.Error) {
	e.t.Helper()
	var body []byte
	if in != nil {
		var err error
		if body, err = proto.Marshal(in); err != nil {
			e.t.Fatal(err)
		}
	}
	status, data := e.doRaw(method, path, token, body)
	if status >= 300 {
		var apiErr obsyncv1.Error
		if err := proto.Unmarshal(data, &apiErr); err != nil {
			e.t.Fatalf("%s %s: status %d with undecodable body %q", method, path, status, data)
		}
		return status, &apiErr
	}
	if out != nil {
		if err := proto.Unmarshal(data, out); err != nil {
			e.t.Fatalf("%s %s: decode response: %v", method, path, err)
		}
	}
	return status, nil
}

// doRaw sends body with the Content-Type a well-behaved client uses: raw
// bytes for a chunk upload, protobuf for everything else.
func (e *testEnv) doRaw(method, path, token string, body []byte) (int, []byte) {
	e.t.Helper()
	ct := "application/x-protobuf"
	if method == "PUT" && strings.Contains(path, "/chunks/") {
		ct = "application/octet-stream"
	}
	return e.doContentType(method, path, token, ct, body)
}

// doContentType sends body with Content-Type ct, omitting the header if ct
// is empty.
func (e *testEnv) doContentType(method, path, token, ct string, body []byte) (int, []byte) {
	e.t.Helper()
	var r io.Reader
	if body != nil {
		r = bytes.NewReader(body)
	}
	req, err := http.NewRequest(method, e.url+path, r)
	if err != nil {
		e.t.Fatal(err)
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	if ct != "" {
		req.Header.Set("Content-Type", ct)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		e.t.Fatal(err)
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		e.t.Fatal(err)
	}
	return resp.StatusCode, data
}

func wantErr(t *testing.T, status int, apiErr *obsyncv1.Error, wantStatus int, wantCode obsyncv1.ErrorCode) {
	t.Helper()
	if status != wantStatus || apiErr == nil || apiErr.Code != wantCode {
		t.Fatalf("got %d %v, want %d %v", status, apiErr, wantStatus, wantCode)
	}
}
