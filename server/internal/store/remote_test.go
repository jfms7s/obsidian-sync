package store_test

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/jfms7s/obsidian-sync/server/internal/store"
)

// Remote databases wait for clustered mode: a remote URL fails at Open, and
// the error carries neither the URL nor the token.
func TestRemoteDatabasesAreNotSupported(t *testing.T) {
	for _, u := range []string{"libsql://db.example", "https://db.example", "http://127.0.0.1:8080"} {
		_, err := store.Open(context.Background(), store.Options{URL: u, AuthToken: "hunter2"})
		if !errors.Is(err, store.ErrRemoteNotSupported) || !strings.Contains(err.Error(), "not supported") ||
			strings.Contains(err.Error(), "hunter2") || strings.Contains(err.Error(), "db.example") {
			t.Errorf("%s: err = %v", u, err)
		}
	}
}
