package app_test

import (
	"bytes"
	"context"
	"encoding/hex"
	"io"
	"log/slog"
	"net"
	"net/http"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/jfms7s/obsidian-sync/server/internal/admin"
	"github.com/jfms7s/obsidian-sync/server/internal/app"
	"github.com/jfms7s/obsidian-sync/server/internal/auth"
	"github.com/jfms7s/obsidian-sync/server/internal/config"
	obsyncv1 "github.com/jfms7s/obsidian-sync/server/internal/gen/obsync/v1"
	"github.com/jfms7s/obsidian-sync/server/internal/ids"
)

func buildWith(t *testing.T, vars map[string]string) (*app.App, config.Config) {
	t.Helper()
	dir := t.TempDir()
	cfg, err := config.Load("", func(k string) string {
		if k == "OBSYNC_DATA_DIR" {
			return dir
		}
		return vars[k]
	})
	if err != nil {
		t.Fatal(err)
	}
	a, err := app.Build(context.Background(), cfg, slog.New(slog.NewTextHandler(io.Discard, nil)),
		app.Options{PasswordParams: auth.FastParams, Version: "9.9.9-test"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { a.Close() })
	return a, cfg
}

func get(t *testing.T, url string) (int, string) {
	t.Helper()
	req, _ := http.NewRequest("GET", url, nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(b)
}

// Without OBSYNC_METRICS_LISTEN nothing is collected and the API never
// serves /metrics.
func TestMetricsOffByDefault(t *testing.T) {
	a, _ := buildWith(t, nil)
	if a.Metrics != nil {
		t.Fatal("metrics are on without metrics_listen")
	}
	ln, _ := net.Listen("tcp", "127.0.0.1:0")
	ctx, stop := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- a.Serve(ctx, ln) }()
	if status, _ := get(t, "http://"+ln.Addr().String()+"/metrics"); status != 404 {
		t.Fatalf("GET /metrics on the API = %d, want 404", status)
	}
	stop()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

// With metrics on, /metrics answers on its own listener only, the counters
// move with real requests, no identifier appears, and both listeners close
// on shutdown.
func TestMetricsListener(t *testing.T) {
	a, cfg := buildWith(t, map[string]string{
		"OBSYNC_METRICS_LISTEN":      "127.0.0.1:0",
		"OBSYNC_RATE_LIMIT_IP_RPS":   "0.01",
		"OBSYNC_RATE_LIMIT_IP_BURST": "4",
	})
	if a.Metrics == nil {
		t.Fatal("metrics are off with metrics_listen set")
	}
	err := admin.Run(context.Background(), []string{"user", "create", "--username", "metricsuser"}, admin.Deps{
		Store: a.Store, Blobs: a.Blobs, DefaultQuotaBytes: cfg.DefaultQuotaBytes, Params: auth.FastParams,
		Stdin: strings.NewReader("correct horse\n"), Stdout: io.Discard,
	})
	if err != nil {
		t.Fatal(err)
	}
	ln, _ := net.Listen("tcp", "127.0.0.1:0")
	mln, _ := net.Listen("tcp", "127.0.0.1:0")
	goroutines := runtime.NumGoroutine()
	ctx, stop := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- a.ServeWithMetrics(ctx, ln, mln) }()
	base, metricsURL := "http://"+ln.Addr().String(), "http://"+mln.Addr().String()+"/metrics"
	c := &client{t: t, base: base}

	if status, _ := get(t, base+"/metrics"); status != 404 {
		t.Fatalf("GET /metrics on the API = %d, want 404", status)
	}
	// One failed login, then a good one (the IP budget is 4).
	c.call("POST", "/v1/auth/login", &obsyncv1.LoginRequest{Username: "metricsuser", Password: "wrong one"}, nil, 401)
	var login obsyncv1.LoginResponse
	c.call("POST", "/v1/auth/login", &obsyncv1.LoginRequest{Username: "metricsuser", Password: "correct horse", DeviceName: "metrics-laptop"}, &login, 200)
	c.token = login.Token
	vaultID := ids.New()
	c.call("POST", "/v1/vaults", &obsyncv1.CreateVaultRequest{VaultId: vaultID, EncName: []byte("n"),
		Keys: []*obsyncv1.VaultKey{{Epoch: 0, SealedKey: []byte("k0")}, {Epoch: 1, SealedKey: []byte("k1")}}}, nil, 201)
	chunk := bytes.Repeat([]byte{7}, 32)
	putChunk(c, vaultID, chunk, "ciphertext")
	c.call("GET", "/v1/vaults/"+vaultID+"/chunks/"+hex.EncodeToString(chunk), nil, nil, 200)
	fileID := bytes.Repeat([]byte{1}, 32)
	var cr obsyncv1.CommitResponse
	c.call("POST", "/v1/vaults/"+vaultID+"/commit", &obsyncv1.CommitRequest{Commits: []*obsyncv1.Commit{
		{FileId: fileID, VersionId: ids.Bytes(16), Epoch: 1, EncMeta: []byte("m"), ChunkIds: [][]byte{chunk}, Size: 10},
		{FileId: fileID, VersionId: ids.Bytes(16), Epoch: 1, EncMeta: []byte("m")}, // also "new": a conflict
	}}, &cr, 200)
	// Spend the rest of the address's login budget: refused with 429.
	for i := 0; i < 2; i++ {
		c.call("POST", "/v1/auth/login", &obsyncv1.LoginRequest{Username: "metricsuser", Password: "wrong one"}, nil, 401)
	}
	c.call("POST", "/v1/auth/login", &obsyncv1.LoginRequest{Username: "metricsuser", Password: "wrong one"}, nil, 429)

	// Serve's maintenance runner makes its first pass at once.
	var status int
	var body string
	for deadline := time.Now().Add(5 * time.Second); ; time.Sleep(20 * time.Millisecond) {
		status, body = get(t, metricsURL)
		if status != 200 {
			t.Fatalf("GET /metrics = %d", status)
		}
		if !strings.Contains(body, `obsync_maintenance_runs_total{result="ok"} 0`) || time.Now().After(deadline) {
			break
		}
	}
	for _, want := range []string{
		`obsync_build_info{version="9.9.9-test"} 1`,
		`obsync_logins_total{result="ok"} 1`, `obsync_logins_total{result="failed"} 3`,
		`obsync_commits_total{result="ok"} 1`, `obsync_commits_total{result="conflict"} 1`,
		"obsync_chunk_uploads_total 1", "obsync_chunk_upload_bytes_total 10", "obsync_chunk_downloads_total 1",
		`obsync_rate_limited_total{limiter="ip"} 1`,
		`obsync_maintenance_runs_total{result="ok"} 1`, `obsync_maintenance_runs_total{result="failed"} 0`,
		"obsync_users 1", "obsync_vaults 1", "obsync_devices_active 1", "obsync_storage_used_bytes 10",
	} {
		if !strings.Contains(body, "\n"+want+"\n") {
			t.Errorf("metrics lack %q:\n%s", want, body)
		}
	}
	if strings.Contains(body, `obsync_maintenance_last_success_timestamp_seconds 0`+"\n") {
		t.Error("the last-success timestamp did not move")
	}
	// No identifier of the account, its device or its vault appears.
	var user string
	if u, err := a.Store.UserByUsername(context.Background(), "metricsuser"); err == nil {
		user = u.ID
	}
	for _, secret := range []string{"metricsuser", user, login.DeviceId, "metrics-laptop", vaultID, hex.EncodeToString(chunk), hex.EncodeToString(fileID)} {
		if secret != "" && strings.Contains(body, secret) {
			t.Errorf("metrics contain the identifier %q", secret)
		}
	}

	stop()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("Serve did not return")
	}
	req, _ := http.NewRequest("GET", metricsURL, nil)
	if resp, err := http.DefaultClient.Do(req); err == nil {
		resp.Body.Close()
		t.Fatal("the metrics listener still answers after shutdown")
	}
	deadline := time.Now().Add(2 * time.Second)
	for runtime.NumGoroutine() > goroutines+2 && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if n := runtime.NumGoroutine(); n > goroutines+2 {
		t.Fatalf("%d goroutines after shutdown, %d before Serve", n, goroutines)
	}
}

func putChunk(c *client, vaultID string, id []byte, body string) {
	c.t.Helper()
	req, _ := http.NewRequest("PUT", c.base+"/v1/vaults/"+vaultID+"/chunks/"+hex.EncodeToString(id), strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("Content-Type", "application/octet-stream")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		c.t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 204 {
		c.t.Fatalf("put chunk = %d", resp.StatusCode)
	}
}
