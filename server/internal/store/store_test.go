package store_test

import (
	"context"
	"database/sql"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jfms7s/obsidian-sync/server/internal/ids"
	"github.com/jfms7s/obsidian-sync/server/internal/store"
)

// A second process (obsync admin while obsync serve runs) must wait for the
// other's write lock instead of failing with "database is locked".
func TestOpenWaitsForAnotherWriter(t *testing.T) {
	ctx := context.Background()
	url := "file:" + filepath.Join(t.TempDir(), "meta.db")
	st, err := store.Open(ctx, store.Options{URL: url})
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	if err := st.Migrate(ctx); err != nil {
		t.Fatal(err)
	}

	other, err := sql.Open("libsql", url)
	if err != nil {
		t.Fatal(err)
	}
	defer other.Close()
	other.SetMaxOpenConns(1)
	tx, err := other.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO job_leases (name, holder, expires_at) VALUES ('x', 'y', 0)`); err != nil {
		t.Fatal(err)
	}
	released := make(chan error, 1)
	go func() {
		time.Sleep(300 * time.Millisecond)
		released <- tx.Commit()
	}()

	u := store.User{ID: ids.New(), Username: "alice", PasswordHash: "x", QuotaBytes: 1}
	if err := st.CreateUser(ctx, u); err != nil {
		t.Fatalf("write while another connection holds the lock: %v", err)
	}
	if err := <-released; err != nil {
		t.Fatal(err)
	}
}

// A database URL that does not parse must not be echoed in the error: it can
// carry credentials in its userinfo or query.
func TestOpenParseErrorDoesNotLeakURL(t *testing.T) {
	_, err := store.Open(context.Background(), store.Options{
		URL:       "libsql://admin:hunter2@db example.com/%zz?authToken=hunter2",
		AuthToken: "tok",
	})
	if err == nil {
		t.Fatal("Open succeeded on an invalid URL")
	}
	if strings.Contains(err.Error(), "hunter2") || err.Error() != "parse database url: invalid URL" {
		t.Fatalf("err = %q", err)
	}
}

// The remote auth token must not appear in any error the store returns, even
// when the server echoes it back in an error body.
func TestRemoteErrorsDoNotLeakAuthToken(t *testing.T) {
	const token = "tok-Sup3rSecret+/=value"
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		w.WriteHeader(http.StatusInternalServerError)
		// A misbehaving proxy reflecting the request: header and query.
		fmt.Fprintf(w, "garbage auth=%q query=%q", r.Header.Get("Authorization"), r.URL.RawQuery)
	}))
	defer srv.Close()
	check := func(what string, err error) {
		t.Helper()
		if err == nil {
			t.Fatalf("%s succeeded against a failing server", what)
		}
		msg := err.Error()
		if strings.Contains(msg, token) || strings.Contains(msg, url.QueryEscape(token)) {
			t.Fatalf("%s error leaks the token: %q", what, msg)
		}
		if !strings.Contains(msg, "REDACTED") {
			t.Fatalf("%s error = %q; want the echoed token redacted", what, msg)
		}
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	// Opening does not reach the server; the first statement does.
	st, err := store.Open(ctx, store.Options{URL: srv.URL, AuthToken: token})
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer st.Close()
	if err := st.Ping(ctx); err != nil {
		t.Fatalf("ping: %v", err)
	}
	if n := hits.Load(); n != 0 {
		t.Fatalf("open and ping sent %d requests", n)
	}
	check("migrate", st.Migrate(ctx))
	_, err = st.UserByUsername(ctx, "alice")
	check("query row", err)
	_, err = st.ListUsers(ctx)
	check("query", err)
	check("transaction", st.CreateUser(ctx, store.User{ID: ids.New(), Username: "alice", PasswordHash: "x", QuotaBytes: 1}))
	if hits.Load() == 0 {
		t.Fatal("no request reached the server")
	}

	// A token passed in the URL itself is redacted too.
	st2, err := store.Open(ctx, store.Options{URL: srv.URL + "?authToken=" + url.QueryEscape(token)})
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer st2.Close()
	check("migrate (token in URL)", st2.Migrate(ctx))
}

// An unreachable server fails on the first statement, without the token.
func TestRemoteUnreachableDoesNotLeakAuthToken(t *testing.T) {
	const token = "tok-unreachable-secret"
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := ln.Addr().String()
	ln.Close() // nothing listens there now
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	st, err := store.Open(ctx, store.Options{URL: "http://" + addr, AuthToken: token})
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer st.Close()
	err = st.Migrate(ctx)
	if err == nil || strings.Contains(err.Error(), token) {
		t.Fatalf("migrate err = %v", err)
	}
}

// Credentials in the URL itself (userinfo, and query parameters such as
// remoteEncryptionKey) are redacted from remote errors like the auth token.
func TestRemoteErrorsDoNotLeakURLCredentials(t *testing.T) {
	const (
		user   = "dbadmin-Us3r"
		pass   = "pw-Hunter2+/=secret"
		encKey = "enc-K3y+/=value"
	)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		// A misbehaving proxy reflecting the whole request.
		fmt.Fprintf(w, "garbage url=%q headers=%q", r.URL.String(), r.Header)
		if u, p, ok := r.BasicAuth(); ok {
			fmt.Fprintf(w, " basic=%q:%q", u, p)
		}
		fmt.Fprintf(w, " echo=%q %q %q %q", user, pass, url.QueryEscape(pass), encKey+" "+url.QueryEscape(encKey))
	}))
	defer srv.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	u, _ := url.Parse(srv.URL)
	u.User = url.UserPassword(user, pass)
	u.RawQuery = "remoteEncryptionKey=" + url.QueryEscape(encKey)
	st, err := store.Open(ctx, store.Options{URL: u.String(), AuthToken: "tok"})
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer st.Close()
	err = st.Migrate(ctx)
	if err == nil {
		t.Fatal("migrate succeeded against a failing server")
	}
	msg := err.Error()
	for _, s := range []string{user, pass, url.QueryEscape(pass), encKey, url.QueryEscape(encKey)} {
		if strings.Contains(msg, s) {
			t.Fatalf("error leaks %q: %q", s, msg)
		}
	}
	if !strings.Contains(msg, "REDACTED") {
		t.Fatalf("error = %q; want credentials redacted", msg)
	}
}
