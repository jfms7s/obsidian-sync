package api_test

import (
	"bytes"
	"encoding/hex"
	"net/http"
	"testing"

	"google.golang.org/protobuf/proto"

	"github.com/jfms7s/obsidian-sync/server/internal/apperr"
	obsyncv1 "github.com/jfms7s/obsidian-sync/server/internal/gen/obsync/v1"
)

func TestProtoBodyRequiresProtobufContentType(t *testing.T) {
	e := newTestEnv(t)
	e.createUser("alice", "correct horse")
	login, _ := proto.Marshal(&obsyncv1.LoginRequest{Username: "alice", Password: "correct horse", DeviceName: "d"})
	for _, ct := range []string{"", "text/plain", "application/json", "application/octet-stream", "application/x-protobufx"} {
		status, data := e.doContentType("POST", "/v1/auth/login", "", ct, login)
		var apiErr obsyncv1.Error
		if err := proto.Unmarshal(data, &apiErr); err != nil {
			t.Fatalf("%q: undecodable body %q", ct, data)
		}
		if status != http.StatusUnsupportedMediaType || apiErr.Code != apperr.Invalid {
			t.Errorf("Content-Type %q: got %d %v, want 415 INVALID", ct, status, &apiErr)
		}
	}
	for _, ct := range []string{"application/x-protobuf", "application/x-protobuf; charset=binary", "Application/X-Protobuf"} {
		if status, data := e.doContentType("POST", "/v1/auth/login", "", ct, login); status != http.StatusOK {
			t.Errorf("Content-Type %q: got %d %q, want 200", ct, status, data)
		}
	}
}

func TestChunkUploadContentType(t *testing.T) {
	e := newTestEnv(t)
	e.createUser("alice", "correct horse")
	token, _ := e.login("alice", "correct horse")
	vault := e.createVault(token)
	for i, tc := range []struct {
		ct   string
		want int
	}{
		{"application/octet-stream", http.StatusNoContent},
		{"", http.StatusNoContent},
		{"application/octet-stream; foo=bar", http.StatusNoContent},
		{"application/x-protobuf", http.StatusUnsupportedMediaType},
		{"text/plain", http.StatusUnsupportedMediaType},
		{"multipart/form-data; boundary=x", http.StatusUnsupportedMediaType},
	} {
		id := hex.EncodeToString(bytes.Repeat([]byte{byte(i + 1)}, 32))
		status, data := e.doContentType("PUT", "/v1/vaults/"+vault+"/chunks/"+id, token, tc.ct, []byte("ciphertext"))
		if status != tc.want {
			t.Errorf("Content-Type %q: got %d %q, want %d", tc.ct, status, data, tc.want)
			continue
		}
		if tc.want == http.StatusUnsupportedMediaType {
			var apiErr obsyncv1.Error
			if err := proto.Unmarshal(data, &apiErr); err != nil || apiErr.Code != apperr.Invalid {
				t.Errorf("Content-Type %q: error body %q", tc.ct, data)
			}
		}
	}
}
