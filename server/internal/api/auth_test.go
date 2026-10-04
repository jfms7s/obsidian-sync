package api_test

import (
	"bytes"
	"net/http"
	"testing"

	"google.golang.org/protobuf/proto"

	"github.com/jfms7s/obsidian-sync/server/internal/apperr"
	obsyncv1 "github.com/jfms7s/obsidian-sync/server/internal/gen/obsync/v1"
)

func TestHealth(t *testing.T) {
	e := newTestEnv(t)
	for _, path := range []string{"/healthz", "/readyz"} {
		if status, body := e.doRaw("GET", path, "", nil); status != 200 || string(body) != "ok" {
			t.Errorf("%s = %d %q", path, status, body)
		}
	}
}

func TestLoginAndListDevices(t *testing.T) {
	e := newTestEnv(t)
	e.createUser("alice", "correct horse")
	token, deviceID := e.login("alice", "correct horse")

	var list obsyncv1.ListDevicesResponse
	if status, apiErr := e.do("GET", "/v1/devices", token, nil, &list); status != 200 {
		t.Fatalf("%d %v", status, apiErr)
	}
	if len(list.Devices) != 1 || list.Devices[0].DeviceId != deviceID || !list.Devices[0].Current || list.Devices[0].Name != "laptop" {
		t.Fatalf("devices = %v", list.Devices)
	}
}

func TestAuthFailures(t *testing.T) {
	e := newTestEnv(t)
	e.createUser("alice", "correct horse")

	status, apiErr := e.do("POST", "/v1/auth/login", "", &obsyncv1.LoginRequest{Username: "alice", Password: "nope"}, nil)
	wantErr(t, status, apiErr, 401, apperr.Unauthorized)

	status, apiErr = e.do("GET", "/v1/devices", "", nil, nil)
	wantErr(t, status, apiErr, 401, apperr.Unauthorized)

	status, apiErr = e.do("GET", "/v1/devices", "made-up", nil, nil)
	wantErr(t, status, apiErr, 401, apperr.Unauthorized)

	status, body := e.doRaw("POST", "/v1/auth/login", "", []byte{0xff, 0xff, 0xff})
	if status != 400 {
		t.Fatalf("garbage body = %d %q", status, body)
	}
}

func TestRevokeAndLogout(t *testing.T) {
	e := newTestEnv(t)
	e.createUser("alice", "correct horse")
	laptop, _ := e.login("alice", "correct horse")
	phone, phoneID := e.login("alice", "correct horse")

	if status, apiErr := e.do("DELETE", "/v1/devices/"+phoneID, laptop, nil, nil); status != http.StatusNoContent {
		t.Fatalf("revoke = %d %v", status, apiErr)
	}
	status, apiErr := e.do("GET", "/v1/devices", phone, nil, nil)
	wantErr(t, status, apiErr, 401, apperr.DeviceRevoked)

	status, apiErr = e.do("DELETE", "/v1/devices/"+"00000000000000000000000000000000", laptop, nil, nil)
	wantErr(t, status, apiErr, 404, apperr.NotFound)

	if status, _ := e.do("POST", "/v1/auth/logout", laptop, nil, nil); status != http.StatusNoContent {
		t.Fatalf("logout = %d", status)
	}
	status, apiErr = e.do("GET", "/v1/devices", laptop, nil, nil)
	wantErr(t, status, apiErr, 401, apperr.DeviceRevoked)
}

func validBundle() *obsyncv1.KeyBundle {
	return &obsyncv1.KeyBundle{
		PublicEncKey:    bytes.Repeat([]byte{1}, 32),
		PublicSignKey:   bytes.Repeat([]byte{2}, 32),
		PassSalt:        bytes.Repeat([]byte{3}, 16),
		PassParams:      &obsyncv1.Argon2Params{MemoryKib: 19456, Iterations: 2, Parallelism: 1},
		PassWrapped:     []byte("wrapped-by-passphrase"),
		RecoveryWrapped: []byte("wrapped-by-recovery-key"),
	}
}

func TestKeyBundleRoundTrip(t *testing.T) {
	e := newTestEnv(t)
	e.createUser("alice", "correct horse")
	token, _ := e.login("alice", "correct horse")

	status, apiErr := e.do("GET", "/v1/keys", token, nil, nil)
	wantErr(t, status, apiErr, 404, apperr.NotFound)

	if status, apiErr := e.do("PUT", "/v1/keys", token, validBundle(), nil); status != http.StatusNoContent {
		t.Fatalf("put = %d %v", status, apiErr)
	}
	var got obsyncv1.KeyBundle
	if status, apiErr := e.do("GET", "/v1/keys", token, nil, &got); status != 200 {
		t.Fatalf("get = %d %v", status, apiErr)
	}
	if !proto.Equal(&got, validBundle()) {
		t.Fatalf("got %v", &got)
	}

	changed := validBundle()
	changed.PublicEncKey = bytes.Repeat([]byte{9}, 32)
	status, apiErr = e.do("PUT", "/v1/keys", token, changed, nil)
	wantErr(t, status, apiErr, 400, apperr.Invalid)

	weak := validBundle()
	weak.PassParams.MemoryKib = 64
	status, apiErr = e.do("PUT", "/v1/keys", token, weak, nil)
	wantErr(t, status, apiErr, 400, apperr.Invalid)
}
