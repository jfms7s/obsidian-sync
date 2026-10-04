package api_test

import (
	"bytes"
	"encoding/hex"
	"io"
	"net/http"
	"strings"
	"testing"
)

func (e *testEnv) putChunk(token, vault string, id []byte, body string) {
	e.t.Helper()
	if status, data := e.doRaw("PUT", "/v1/vaults/"+vault+"/chunks/"+hex.EncodeToString(id), token, []byte(body)); status != http.StatusNoContent {
		e.t.Fatalf("put chunk = %d %q", status, data)
	}
}

func (e *testEnv) getChunk(token, vault, idHex string) (*http.Response, []byte, error) {
	e.t.Helper()
	req, err := http.NewRequest("GET", e.url+"/v1/vaults/"+vault+"/chunks/"+idHex, nil)
	if err != nil {
		e.t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, nil, err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(resp.Body)
	return resp, data, err
}

func TestGetChunkHeaders(t *testing.T) {
	e := newTestEnv(t)
	e.createUser("alice", "correct horse")
	token, _ := e.login("alice", "correct horse")
	vault := e.createVault(token)
	id := bytes.Repeat([]byte{0xab}, 32)
	e.putChunk(token, vault, id, "ciphertext")

	resp, data, err := e.getChunk(token, vault, hex.EncodeToString(id))
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != 200 || string(data) != "ciphertext" {
		t.Fatalf("get chunk = %d %q", resp.StatusCode, data)
	}
	if resp.ContentLength != int64(len("ciphertext")) {
		t.Errorf("Content-Length = %d, want %d", resp.ContentLength, len("ciphertext"))
	}
	for k, want := range map[string]string{
		"Content-Type":           "application/octet-stream",
		"Cache-Control":          "no-store",
		"X-Content-Type-Options": "nosniff",
	} {
		if got := resp.Header.Get(k); got != want {
			t.Errorf("%s = %q, want %q", k, got, want)
		}
	}
}

// A blob that cannot be read in full must not reach the client as a clean
// 200: the connection is aborted so the client sees a transport error.
func TestGetChunkAbortsOnBlobReadFailure(t *testing.T) {
	e := newTestEnv(t)
	e.createUser("alice", "correct horse")
	token, _ := e.login("alice", "correct horse")
	vault := e.createVault(token)
	id := bytes.Repeat([]byte{0xcd}, 32)
	e.putChunk(token, vault, id, "ciphertext")

	// The blob opens fine but fails after the first few bytes, once the
	// 200 status line is already on the wire.
	e.failBlobReads.Store(true)
	resp, data, err := e.getChunk(token, vault, hex.EncodeToString(id))
	if err == nil {
		t.Fatalf("get chunk = %d %q with no error, want a transport error", resp.StatusCode, data)
	}
}

func TestHexIDsMustBeLowercase(t *testing.T) {
	e := newTestEnv(t)
	e.createUser("alice", "correct horse")
	token, _ := e.login("alice", "correct horse")
	vault := e.createVault(token)
	base := "/v1/vaults/" + vault
	id := bytes.Repeat([]byte{0xab}, 32)
	e.putChunk(token, vault, id, "ciphertext")
	upper := strings.ToUpper(hex.EncodeToString(id))

	for _, tc := range []struct{ method, path string }{
		{"GET", base + "/chunks/" + upper},
		{"PUT", base + "/chunks/" + upper},
		{"GET", base + "/files/" + upper + "/history"},
		{"GET", base + "/heads?after=" + upper},
	} {
		if status, _ := e.doRaw(tc.method, tc.path, token, []byte("x")); status != 400 {
			t.Errorf("%s %s = %d, want 400", tc.method, tc.path, status)
		}
	}
}
