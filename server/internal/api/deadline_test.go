package api_test

import (
	"bufio"
	"bytes"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/jfms7s/obsidian-sync/server/internal/api"
)

// slowRequest sends the request head and then dribbles body bytes, one every
// 50ms, never finishing the declared Content-Length. It returns the response
// status the server sends (0 if it just closes) and how long that took.
func slowRequest(t *testing.T, baseURL, method, path, token, contentType string, contentLength int) (int, time.Duration) {
	t.Helper()
	conn, err := net.Dial("tcp", strings.TrimPrefix(baseURL, "http://"))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	head := fmt.Sprintf("%s %s HTTP/1.1\r\nHost: test\r\nContent-Length: %d\r\n", method, path, contentLength)
	if token != "" {
		head += "Authorization: Bearer " + token + "\r\n"
	}
	if contentType != "" {
		head += "Content-Type: " + contentType + "\r\n"
	}
	if _, err := conn.Write([]byte(head + "\r\n")); err != nil {
		t.Fatal(err)
	}
	start := time.Now()
	stopDribble := make(chan struct{})
	defer close(stopDribble)
	go func() {
		tick := time.NewTicker(50 * time.Millisecond)
		defer tick.Stop()
		for i := 0; i < contentLength-1; i++ {
			select {
			case <-stopDribble:
				return
			case <-tick.C:
				if _, err := conn.Write([]byte{0x0a}); err != nil {
					return
				}
			}
		}
	}()
	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	resp, err := http.ReadResponse(bufio.NewReader(conn), nil)
	if err != nil {
		var ne net.Error
		if errors.As(err, &ne) && ne.Timeout() {
			t.Fatalf("%s %s: server still waiting for the body after %v", method, path, time.Since(start))
		}
		return 0, time.Since(start)
	}
	resp.Body.Close()
	return resp.StatusCode, time.Since(start)
}

func TestSlowProtoBodyIsCutOff(t *testing.T) {
	// Registered first so it runs after the test server has closed.
	t.Cleanup(api.SetBodyReadTimeouts(300*time.Millisecond, time.Hour))
	e := newTestEnv(t)
	status, took := slowRequest(t, e.url, "POST", "/v1/auth/login", "", "application/x-protobuf", 1000)
	if took > 3*time.Second {
		t.Fatalf("cut off after %v", took)
	}
	if status != 0 && status != http.StatusBadRequest {
		t.Fatalf("status = %d", status)
	}
}

func TestSlowChunkBodyIsCutOff(t *testing.T) {
	// Registered first so it runs after the test server has closed.
	t.Cleanup(api.SetBodyReadTimeouts(time.Hour, 300*time.Millisecond))
	e := newTestEnv(t)
	e.createUser("alice", "correct horse")
	token, _ := e.login("alice", "correct horse")
	vault := e.createVault(token)
	id := bytes.Repeat([]byte{0xab}, 32)
	path := fmt.Sprintf("/v1/vaults/%s/chunks/%x", vault, id)
	if _, took := slowRequest(t, e.url, "PUT", path, token, "application/octet-stream", 1000); took > 3*time.Second {
		t.Fatalf("cut off after %v", took)
	}
	// The aborted upload left nothing behind; a normal upload still works.
	e.putChunk(token, vault, id, "ciphertext")
}

// A request whose body arrives in time is unaffected, and the deadline does
// not linger onto the next request on the same keep-alive connection.
func TestBodyDeadlineDoesNotOutliveTheRead(t *testing.T) {
	// Registered first so it runs after the test server has closed.
	t.Cleanup(api.SetBodyReadTimeouts(200*time.Millisecond, 200*time.Millisecond))
	e := newTestEnv(t)
	e.createUser("alice", "correct horse")
	token, _ := e.login("alice", "correct horse")
	time.Sleep(300 * time.Millisecond) // idle keep-alive past the deadline
	vault := e.createVault(token)
	e.putChunk(token, vault, bytes.Repeat([]byte{0xab}, 32), "ciphertext")
}

// A request rejected before its body is read (here for its Content-Type) is
// still bounded: net/http drains a small unread body before replying.
func TestSlowBodyWithWrongContentTypeIsCutOff(t *testing.T) {
	// Registered first so it runs after the test server has closed.
	t.Cleanup(api.SetBodyReadTimeouts(300*time.Millisecond, 300*time.Millisecond))
	e := newTestEnv(t)
	e.createUser("alice", "correct horse")
	token, _ := e.login("alice", "correct horse")
	vault := e.createVault(token)
	path := fmt.Sprintf("/v1/vaults/%s/chunks/%x", vault, bytes.Repeat([]byte{0xab}, 32))
	for _, tc := range []struct{ method, path, token string }{
		{"POST", "/v1/auth/login", ""},
		{"PUT", path, token},
	} {
		status, took := slowRequest(t, e.url, tc.method, tc.path, tc.token, "text/plain", 1000)
		if took > 3*time.Second {
			t.Fatalf("%s %s: cut off after %v", tc.method, tc.path, took)
		}
		if status != 0 && status != http.StatusUnsupportedMediaType {
			t.Fatalf("%s %s: status = %d", tc.method, tc.path, status)
		}
	}
}

// smallBufListener shrinks each accepted connection's send buffer so a
// download to a client that does not read blocks quickly.
type smallBufListener struct{ net.Listener }

func (l smallBufListener) Accept() (net.Conn, error) {
	c, err := l.Listener.Accept()
	if tc, ok := c.(*net.TCPConn); ok {
		_ = tc.SetWriteBuffer(4 << 10)
	}
	return c, err
}

// A client that requests a chunk and then stops reading must not hold the
// handler and connection forever: the write deadline ends the download.
func TestStalledChunkDownloadIsCutOff(t *testing.T) {
	// Registered first so it runs after the test servers have closed.
	t.Cleanup(api.SetChunkWriteTimeout(300 * time.Millisecond))
	e := newTestEnv(t)
	e.createUser("alice", "correct horse")
	token, _ := e.login("alice", "correct horse")
	vault := e.createVault(token)
	id := bytes.Repeat([]byte{0xab}, 32)
	e.putChunk(token, vault, id, strings.Repeat("x", 2<<20))

	done := make(chan struct{})
	srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer close(done)
		e.handler.ServeHTTP(w, r)
	}))
	srv.Listener = smallBufListener{srv.Listener}
	srv.Start()
	t.Cleanup(srv.Close)

	conn, err := net.Dial("tcp", srv.Listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_ = conn.(*net.TCPConn).SetReadBuffer(4 << 10)
	req := fmt.Sprintf("GET /v1/vaults/%s/chunks/%x HTTP/1.1\r\nHost: test\r\nAuthorization: Bearer %s\r\n\r\n", vault, id, token)
	if _, err := conn.Write([]byte(req)); err != nil {
		t.Fatal(err)
	}
	// Never read the response.
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("chunk download still blocked on a client that stopped reading")
	}
}

// The download deadline does not linger onto the next request on the same
// keep-alive connection.
func TestChunkWriteDeadlineDoesNotOutliveTheDownload(t *testing.T) {
	// Registered first so it runs after the test server has closed.
	t.Cleanup(api.SetChunkWriteTimeout(200 * time.Millisecond))
	e := newTestEnv(t)
	e.createUser("alice", "correct horse")
	token, _ := e.login("alice", "correct horse")
	vault := e.createVault(token)
	id := bytes.Repeat([]byte{0xab}, 32)
	e.putChunk(token, vault, id, "ciphertext")
	if _, body, err := e.getChunk(token, vault, fmt.Sprintf("%x", id)); err != nil || string(body) != "ciphertext" {
		t.Fatalf("get chunk = %q, %v", body, err)
	}
	time.Sleep(300 * time.Millisecond) // idle keep-alive past the deadline
	if _, body, err := e.getChunk(token, vault, fmt.Sprintf("%x", id)); err != nil || string(body) != "ciphertext" {
		t.Fatalf("second get chunk = %q, %v", body, err)
	}
}
