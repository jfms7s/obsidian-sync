package blob_test

import (
	"bytes"
	"context"
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/jfms7s/obsidian-sync/server/internal/blob"
	"github.com/jfms7s/obsidian-sync/server/internal/blob/blobtest"
)

func TestFS(t *testing.T) {
	blobtest.Run(t, func(t *testing.T) blob.Store {
		s, err := blob.NewFS(t.TempDir())
		if err != nil {
			t.Fatal(err)
		}
		return s
	})
}

func TestFSFailedPutLeavesNoFiles(t *testing.T) {
	root := t.TempDir()
	s, err := blob.NewFS(root)
	if err != nil {
		t.Fatal(err)
	}
	r := io.MultiReader(bytes.NewReader([]byte("partial")), errReader{})
	if err := s.Put(context.Background(), "v1/ab/abcd", r); err == nil {
		t.Fatal("expected the reader's error")
	}
	if files := regularFiles(t, root); len(files) != 0 {
		t.Fatalf("files left behind: %v", files)
	}
}

func TestNewFSSweepsStaleTempFiles(t *testing.T) {
	root := t.TempDir()
	ctx := context.Background()
	s, err := blob.NewFS(root)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Put(ctx, "v1/ab/abcd", bytes.NewReader([]byte("real"))); err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(root, "v1", "ab")
	stale := filepath.Join(dir, ".tmp-111")
	fresh := filepath.Join(dir, ".tmp-222")
	staleTop := filepath.Join(root, ".tmp-333")
	for _, p := range []string{stale, fresh, staleTop} {
		if err := os.WriteFile(p, []byte("junk"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	old := time.Now().Add(-2 * time.Hour)
	for _, p := range []string{stale, staleTop} {
		if err := os.Chtimes(p, old, old); err != nil {
			t.Fatal(err)
		}
	}
	// A real blob that is old must never be swept.
	if err := os.Chtimes(filepath.Join(dir, "abcd"), old, old); err != nil {
		t.Fatal(err)
	}

	s, err = blob.NewFS(root)
	if err != nil {
		t.Fatal(err)
	}
	for _, p := range []string{stale, staleTop} {
		if _, err := os.Stat(p); !errors.Is(err, fs.ErrNotExist) {
			t.Errorf("stale temp file %s still present (err=%v)", p, err)
		}
	}
	if _, err := os.Stat(fresh); err != nil {
		t.Errorf("fresh temp file removed: %v", err)
	}
	rc, err := s.Get(ctx, "v1/ab/abcd")
	if err != nil {
		t.Fatal(err)
	}
	defer rc.Close()
	if b, _ := io.ReadAll(rc); string(b) != "real" {
		t.Fatalf("real blob = %q", b)
	}
}

type errReader struct{}

func (errReader) Read([]byte) (int, error) { return 0, errors.New("connection reset") }

func regularFiles(t *testing.T, root string) []string {
	t.Helper()
	var out []string
	err := filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if !d.IsDir() {
			out = append(out, p)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return out
}
