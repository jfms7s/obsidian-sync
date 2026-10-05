package main

import (
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestHealthTarget(t *testing.T) {
	cases := []struct {
		listen, want string
		wantErr      bool
	}{
		{listen: ":8080", want: "127.0.0.1:8080"},
		{listen: "0.0.0.0:9000", want: "127.0.0.1:9000"},
		{listen: "[::]:9000", want: "127.0.0.1:9000"},
		{listen: "127.0.0.1:8081", want: "127.0.0.1:8081"},
		{listen: "[::1]:8082", want: "[::1]:8082"},
		{listen: "10.0.0.5:80", want: "10.0.0.5:80"},
		{listen: "localhost:8083", want: "localhost:8083"},
		{listen: "8080", wantErr: true},
		{listen: "", wantErr: true},
		{listen: "host:", wantErr: true},
	}
	for _, c := range cases {
		got, err := healthTarget(c.listen)
		if c.wantErr {
			if err == nil {
				t.Errorf("healthTarget(%q) = %q, want an error", c.listen, got)
			}
			continue
		}
		if err != nil || got != c.want {
			t.Errorf("healthTarget(%q) = %q, %v; want %q", c.listen, got, err, c.want)
		}
	}
}

// listenAt points the health command at srv through OBSYNC_LISTEN.
func listenAt(t *testing.T, srv *httptest.Server) {
	t.Helper()
	t.Setenv("OBSYNC_LISTEN", strings.TrimPrefix(srv.URL, "http://"))
}

func TestHealthSucceedsOnReadyz200(t *testing.T) {
	var path atomic.Value
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path.Store(r.Method + " " + r.URL.Path)
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()
	listenAt(t, srv)
	if err := run(context.Background(), []string{"health"}); err != nil {
		t.Fatal(err)
	}
	if got := path.Load(); got != "GET /readyz" {
		t.Fatalf("request = %v, want GET /readyz", got)
	}
}

func TestHealthFailsOnNon200(t *testing.T) {
	for _, status := range []int{http.StatusServiceUnavailable, http.StatusNotFound, http.StatusNoContent, http.StatusFound} {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if status == http.StatusFound {
				w.Header().Set("Location", "/elsewhere")
			}
			w.WriteHeader(status)
		}))
		listenAt(t, srv)
		err := run(context.Background(), []string{"health"})
		srv.Close()
		if err == nil || !strings.Contains(err.Error(), strconv.Itoa(status)) {
			t.Errorf("status %d: err = %v", status, err)
		}
		if err != nil && strings.Contains(err.Error(), "\n") {
			t.Errorf("status %d: reason is not one line: %q", status, err)
		}
	}
}

// A redirect to a healthy address must not make the probe pass.
func TestHealthDoesNotFollowRedirects(t *testing.T) {
	healthy := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	defer healthy.Close()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, healthy.URL+"/readyz", http.StatusFound)
	}))
	defer srv.Close()
	listenAt(t, srv)
	err := run(context.Background(), []string{"health"})
	if err == nil || !strings.Contains(err.Error(), "302") {
		t.Fatalf("err = %v, want a 302 failure", err)
	}
}

func TestHealthTimesOutOnAHungServer(t *testing.T) {
	release := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { <-release }))
	defer srv.Close()
	defer close(release)
	listenAt(t, srv)
	old := healthTimeout
	healthTimeout = 100 * time.Millisecond
	defer func() { healthTimeout = old }()
	start := time.Now()
	if err := run(context.Background(), []string{"health"}); err == nil {
		t.Fatal("expected a timeout error")
	}
	if took := time.Since(start); took > 2*time.Second {
		t.Fatalf("took %v, want about the 100ms timeout", took)
	}
}

func TestHealthFailsWhenConnectionRefused(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := ln.Addr().String()
	_ = ln.Close()
	t.Setenv("OBSYNC_LISTEN", addr)
	if err := run(context.Background(), []string{"health"}); err == nil {
		t.Fatal("expected an error when nothing listens")
	}
}

func TestHealthHonoursConfigFile(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {}))
	defer srv.Close()
	cfgPath := filepath.Join(t.TempDir(), "obsync.yaml")
	cfg := "listen: " + strings.TrimPrefix(srv.URL, "http://") + "\n"
	if err := os.WriteFile(cfgPath, []byte(cfg), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("OBSYNC_LISTEN", "")
	for _, args := range [][]string{{"--config", cfgPath, "health"}, {"health", "--config", cfgPath}} {
		if err := run(context.Background(), args); err != nil {
			t.Fatalf("%v: %v", args, err)
		}
	}
	// $OBSYNC_CONFIG is the container HEALTHCHECK's route to the same file.
	t.Setenv("OBSYNC_CONFIG", cfgPath)
	if err := run(context.Background(), []string{"health"}); err != nil {
		t.Fatal(err)
	}
}

func TestHealthRejectsArguments(t *testing.T) {
	err := run(context.Background(), []string{"health", "extra"})
	if err == nil || !strings.Contains(err.Error(), "unexpected argument") {
		t.Fatalf("err = %v", err)
	}
}

func TestUsageListsHealth(t *testing.T) {
	if !strings.Contains(usage, "health") {
		t.Fatal("usage does not mention health")
	}
}
