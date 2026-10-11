package main

import (
	"bytes"
	"context"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The database holds password hashes, token hashes and wrapped key bundles:
// a data dir that already exists with a loose mode (an image's /data, a bind
// mount) must still end up private, and so must the files obsync creates.
func TestDataFilesArePrivate(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "data")
	if err := os.Mkdir(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("OBSYNC_DATA_DIR", dir)
	if err := run(context.Background(), []string{"migrate"}); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{".", "meta.db"} {
		fi, err := os.Stat(filepath.Join(dir, name))
		if err != nil {
			t.Fatal(err)
		}
		want := os.FileMode(0o600)
		if fi.IsDir() {
			want = 0o700
		}
		if perm := fi.Mode().Perm(); perm != want {
			t.Errorf("%s mode = %o, want %o", name, perm, want)
		}
	}
}

// A data dir the process does not own (a Kubernetes volume with fsGroup)
// cannot be chmodded: that is worth a warning, not a refusal to start.
func TestDataDirThatCannotBeMadePrivateOnlyWarns(t *testing.T) {
	file := filepath.Join(t.TempDir(), "file")
	if err := os.WriteFile(file, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	var logs bytes.Buffer
	makeDataPrivate(filepath.Join(file, "data"), slog.New(slog.NewTextHandler(&logs, nil)))
	if !strings.Contains(logs.String(), "level=WARN") {
		t.Fatalf("logs = %q, want a warning", logs.String())
	}
}
