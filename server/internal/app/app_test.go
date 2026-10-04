package app_test

import (
	"bytes"
	"context"
	"encoding/hex"
	"io"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"google.golang.org/protobuf/proto"

	"github.com/jfms7s/obsidian-sync/server/internal/admin"
	"github.com/jfms7s/obsidian-sync/server/internal/app"
	"github.com/jfms7s/obsidian-sync/server/internal/auth"
	"github.com/jfms7s/obsidian-sync/server/internal/config"
	obsyncv1 "github.com/jfms7s/obsidian-sync/server/internal/gen/obsync/v1"
	"github.com/jfms7s/obsidian-sync/server/internal/ids"
)

// TestEndToEnd drives a real server over TCP: an admin creates a user, a
// device logs in, sets up keys and a vault, uploads and commits a chunk,
// sees the WebSocket notification, pulls the change, and finally the server
// shuts down promptly while the WebSocket is still open.
func TestEndToEnd(t *testing.T) {
	dir := t.TempDir()
	cfg, err := config.Load("", func(k string) string {
		if k == "OBSYNC_DATA_DIR" {
			return dir
		}
		return ""
	})
	if err != nil {
		t.Fatal(err)
	}
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	a, err := app.Build(context.Background(), cfg, log, app.Options{PasswordParams: auth.FastParams})
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()

	err = admin.Run(context.Background(), []string{"user", "create", "--username", "alice"}, admin.Deps{
		Store: a.Store, Blobs: a.Blobs, DefaultQuotaBytes: cfg.DefaultQuotaBytes, Params: auth.FastParams,
		Stdin: strings.NewReader("correct horse\n"), Stdout: io.Discard,
	})
	if err != nil {
		t.Fatal(err)
	}

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	ctx, stop := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- a.Serve(ctx, ln) }()
	base := "http://" + ln.Addr().String()
	c := &client{t: t, base: base}

	var login obsyncv1.LoginResponse
	c.call("POST", "/v1/auth/login", &obsyncv1.LoginRequest{Username: "alice", Password: "correct horse", DeviceName: "e2e"}, &login, 200)
	c.token = login.Token

	c.call("PUT", "/v1/keys", &obsyncv1.KeyBundle{
		PublicEncKey: bytes.Repeat([]byte{1}, 32), PublicSignKey: bytes.Repeat([]byte{2}, 32),
		PassSalt: bytes.Repeat([]byte{3}, 16), PassParams: &obsyncv1.Argon2Params{MemoryKib: 19456, Iterations: 2, Parallelism: 1},
		PassWrapped: []byte("p"), RecoveryWrapped: []byte("r"),
	}, nil, 204)

	vaultID := ids.New()
	c.call("POST", "/v1/vaults", &obsyncv1.CreateVaultRequest{VaultId: vaultID, EncName: []byte("n"),
		Keys: []*obsyncv1.VaultKey{{Epoch: 0, SealedKey: []byte("a")}, {Epoch: 1, SealedKey: []byte("b")}}}, nil, 201)

	ws, _, err := websocket.Dial(context.Background(), "ws://"+ln.Addr().String()+"/v1/ws", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer ws.CloseNow()
	wsSend(t, ws, &obsyncv1.ClientFrame{Frame: &obsyncv1.ClientFrame_Auth{Auth: &obsyncv1.Auth{Token: c.token}}})
	if f := wsRecv(t, ws); f.GetAuthOk() == nil {
		t.Fatalf("auth reply = %v", f)
	}
	wsSend(t, ws, &obsyncv1.ClientFrame{Frame: &obsyncv1.ClientFrame_Subscribe{Subscribe: &obsyncv1.Subscribe{VaultIds: []string{vaultID}}}})
	if n := wsRecv(t, ws).GetNotify(); n.GetSeq() != 0 {
		t.Fatalf("initial notify = %v", n)
	}

	chunkID := bytes.Repeat([]byte{0xcd}, 32)
	c.raw("PUT", "/v1/vaults/"+vaultID+"/chunks/"+hex.EncodeToString(chunkID), []byte("ciphertext"), 204)
	var cr obsyncv1.CommitResponse
	c.call("POST", "/v1/vaults/"+vaultID+"/commit", &obsyncv1.CommitRequest{Commits: []*obsyncv1.Commit{{
		FileId: bytes.Repeat([]byte{1}, 32), VersionId: ids.Bytes(16), Epoch: 1, EncMeta: []byte("m"),
		ChunkIds: [][]byte{chunkID}, Size: 10,
	}}}, &cr, 200)
	if !cr.Results[0].Ok {
		t.Fatalf("commit = %v", cr.Results[0])
	}
	if n := wsRecv(t, ws).GetNotify(); n.GetSeq() != 1 {
		t.Fatalf("live notify = %v", n)
	}
	var changes obsyncv1.ChangesResponse
	c.call("GET", "/v1/vaults/"+vaultID+"/changes?since=0", nil, &changes, 200)
	if len(changes.Versions) != 1 {
		t.Fatalf("changes = %v", &changes)
	}
	c.raw("GET", "/healthz", nil, 200)
	c.raw("GET", "/readyz", nil, 200)

	stop()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("serve: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("server did not shut down while a WebSocket was open")
	}
}

type client struct {
	t     *testing.T
	base  string
	token string
}

func (c *client) call(method, path string, in, out proto.Message, wantStatus int) {
	c.t.Helper()
	var body []byte
	if in != nil {
		body, _ = proto.Marshal(in)
	}
	data := c.raw(method, path, body, wantStatus)
	if out != nil {
		if err := proto.Unmarshal(data, out); err != nil {
			c.t.Fatal(err)
		}
	}
}

func (c *client) raw(method, path string, body []byte, wantStatus int) []byte {
	c.t.Helper()
	req, _ := http.NewRequest(method, c.base+path, bytes.NewReader(body))
	if c.token != "" {
		req.Header.Set("Authorization", "Bearer "+c.token)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		c.t.Fatal(err)
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != wantStatus {
		c.t.Fatalf("%s %s = %d, want %d (%q)", method, path, resp.StatusCode, wantStatus, data)
	}
	return data
}

func wsSend(t *testing.T, c *websocket.Conn, f *obsyncv1.ClientFrame) {
	t.Helper()
	data, _ := proto.Marshal(f)
	if err := c.Write(context.Background(), websocket.MessageBinary, data); err != nil {
		t.Fatal(err)
	}
}

func wsRecv(t *testing.T, c *websocket.Conn) *obsyncv1.ServerFrame {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	_, data, err := c.Read(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var f obsyncv1.ServerFrame
	if err := proto.Unmarshal(data, &f); err != nil {
		t.Fatal(err)
	}
	return &f
}
