package api_test

import (
	"bytes"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"

	"google.golang.org/protobuf/encoding/protowire"
	"google.golang.org/protobuf/proto"

	"github.com/jfms7s/obsidian-sync/server/internal/api"
	"github.com/jfms7s/obsidian-sync/server/internal/apperr"
	obsyncv1 "github.com/jfms7s/obsidian-sync/server/internal/gen/obsync/v1"
)

// withUnknownField appends a large field number unknown to every message.
func withUnknownField(t *testing.T, m proto.Message, size int) []byte {
	t.Helper()
	data, err := proto.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	data = protowire.AppendTag(data, 1000, protowire.BytesType)
	return protowire.AppendBytes(data, bytes.Repeat([]byte{0x5a}, size))
}

func TestKeyBundleDropsUnknownFields(t *testing.T) {
	e := newTestEnv(t)
	e.createUser("alice", "correct horse")
	token, _ := e.login("alice", "correct horse")

	body := withUnknownField(t, validBundle(), 32<<10)
	if status, data := e.doRaw("PUT", "/v1/keys", token, body); status != http.StatusNoContent {
		t.Fatalf("put = %d %q", status, data)
	}
	status, data := e.doRaw("GET", "/v1/keys", token, nil)
	if status != 200 {
		t.Fatalf("get = %d", status)
	}
	want, _ := proto.Marshal(validBundle())
	if len(data) != len(want) {
		t.Fatalf("stored bundle is %d bytes, want %d (unknown field kept)", len(data), len(want))
	}
}

func TestBodyLimits(t *testing.T) {
	e := newTestEnv(t)
	e.createUser("alice", "correct horse")
	token, _ := e.login("alice", "correct horse")

	login := withUnknownField(t, &obsyncv1.LoginRequest{Username: "alice", Password: "correct horse"}, 100<<10)
	if status, _ := e.doRaw("POST", "/v1/auth/login", "", login); status != http.StatusRequestEntityTooLarge {
		t.Errorf("100 KiB login = %d, want 413", status)
	}
	keys := withUnknownField(t, validBundle(), 100<<10)
	if status, _ := e.doRaw("PUT", "/v1/keys", token, keys); status != http.StatusRequestEntityTooLarge {
		t.Errorf("100 KiB key bundle = %d, want 413", status)
	}
}

func TestUnknownRoutesReturnProtobufErrors(t *testing.T) {
	e := newTestEnv(t)

	status, apiErr := e.do("GET", "/v1/nope", "", nil, nil)
	wantErr(t, status, apiErr, http.StatusNotFound, apperr.NotFound)

	req, _ := http.NewRequest("PATCH", e.url+"/v1/keys", nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	var pe obsyncv1.Error
	if resp.StatusCode != http.StatusMethodNotAllowed || proto.Unmarshal(data, &pe) != nil || pe.Code != apperr.Invalid {
		t.Fatalf("PATCH /v1/keys = %d %q", resp.StatusCode, data)
	}
	if allow := resp.Header.Get("Allow"); allow == "" {
		t.Error("405 lost its Allow header")
	}
	if ct := resp.Header.Get("Content-Type"); ct != "application/x-protobuf" {
		t.Errorf("405 Content-Type = %q", ct)
	}
}

func TestBearerSchemeIsCaseInsensitive(t *testing.T) {
	e := newTestEnv(t)
	e.createUser("alice", "correct horse")
	token, _ := e.login("alice", "correct horse")

	for _, h := range []string{"bearer " + token, "BEARER  " + token + " "} {
		req, _ := http.NewRequest("GET", e.url+"/v1/devices", nil)
		req.Header.Set("Authorization", h)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != 200 {
			t.Errorf("%q = %d", h[:7], resp.StatusCode)
		}
	}
}

func TestProtobufResponseHeaders(t *testing.T) {
	e := newTestEnv(t)
	e.createUser("alice", "correct horse")
	for _, password := range []string{"correct horse", "wrong"} {
		body, _ := proto.Marshal(&obsyncv1.LoginRequest{Username: "alice", Password: password})
		resp, err := http.Post(e.url+"/v1/auth/login", "application/x-protobuf", bytes.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if got := resp.Header.Get("Cache-Control"); got != "no-store" {
			t.Errorf("%s: Cache-Control = %q", password, got)
		}
		if got := resp.Header.Get("X-Content-Type-Options"); got != "nosniff" {
			t.Errorf("%s: X-Content-Type-Options = %q", password, got)
		}
	}
}

func TestArgon2ParamsAreCapped(t *testing.T) {
	e := newTestEnv(t)
	e.createUser("alice", "correct horse")
	token, _ := e.login("alice", "correct horse")
	for name, p := range map[string]*obsyncv1.Argon2Params{
		"memory":      {MemoryKib: 4<<20 + 1, Iterations: 2, Parallelism: 1},
		"iterations":  {MemoryKib: 19456, Iterations: 65, Parallelism: 1},
		"parallelism": {MemoryKib: 19456, Iterations: 2, Parallelism: 17},
	} {
		kb := validBundle()
		kb.PassParams = p
		if status, apiErr := e.do("PUT", "/v1/keys", token, kb, nil); status != 400 || apiErr.Code != apperr.Invalid {
			t.Errorf("%s: %d %v", name, status, apiErr)
		}
	}
	kb := validBundle()
	kb.PassParams = &obsyncv1.Argon2Params{MemoryKib: 4 << 20, Iterations: 64, Parallelism: 16}
	if status, apiErr := e.do("PUT", "/v1/keys", token, kb, nil); status != http.StatusNoContent {
		t.Errorf("maximum params: %d %v", status, apiErr)
	}
}

func TestNilReadyMeansReady(t *testing.T) {
	h := api.NewHandler(api.Deps{Log: slog.New(slog.NewTextHandler(io.Discard, nil))})
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "/readyz", nil))
	if rec.Code != 200 {
		t.Fatalf("readyz = %d", rec.Code)
	}
}
