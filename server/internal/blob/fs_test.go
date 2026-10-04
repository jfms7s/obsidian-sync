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

// tempLayout writes a real blob plus temp files under root: two stale (one
// nested, one at the root) and one fresh. The real blob is backdated too, to
// show age alone never gets a blob swept.
func tempLayout(t *testing.T, root string) (s *blob.FS, stale []string, fresh string) {
	t.Helper()
	s, err := blob.NewFS(root)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Put(context.Background(), "v1/ab/abcd", bytes.NewReader([]byte("real"))); err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(root, "v1", "ab")
	stale = []string{filepath.Join(dir, ".tmp-111"), filepath.Join(root, ".tmp-333")}
	fresh = filepath.Join(dir, ".tmp-222")
	for _, p := range append([]string{fresh}, stale...) {
		if err := os.WriteFile(p, []byte("junk"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	old := time.Now().Add(-2 * time.Hour)
	for _, p := range append([]string{filepath.Join(dir, "abcd")}, stale...) {
		if err := os.Chtimes(p, old, old); err != nil {
			t.Fatal(err)
		}
	}
	return s, stale, fresh
}

func exists(t *testing.T, p string) bool {
	t.Helper()
	_, err := os.Stat(p)
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		t.Fatal(err)
	}
	return err == nil
}

func TestSweepTempRemovesOnlyStaleTempFiles(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	s, stale, fresh := tempLayout(t, root)

	removed, err := s.SweepTemp(ctx, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	if removed != len(stale) {
		t.Errorf("removed = %d, want %d", removed, len(stale))
	}
	for _, p := range stale {
		if exists(t, p) {
			t.Errorf("stale temp file %s still present", p)
		}
	}
	if !exists(t, fresh) {
		t.Error("fresh temp file removed")
	}
	rc, err := s.Get(ctx, "v1/ab/abcd")
	if err != nil {
		t.Fatal(err)
	}
	defer rc.Close()
	if b, _ := io.ReadAll(rc); string(b) != "real" {
		t.Fatalf("real blob = %q", b)
	}

	// Nothing left to do on a second pass.
	if removed, err := s.SweepTemp(ctx, time.Hour); err != nil || removed != 0 {
		t.Fatalf("second sweep = %d, %v", removed, err)
	}
}

func TestSweepTempStopsWhenContextEnds(t *testing.T) {
	root := t.TempDir()
	s, stale, _ := tempLayout(t, root)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	removed, err := s.SweepTemp(ctx, time.Hour)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v, want context.Canceled", err)
	}
	if removed != 0 {
		t.Errorf("removed = %d after cancellation", removed)
	}
	for _, p := range stale {
		if !exists(t, p) {
			t.Errorf("%s removed after cancellation", p)
		}
	}
}

func TestSweepTempMissingRootIsError(t *testing.T) {
	root := filepath.Join(t.TempDir(), "blobs")
	s, err := blob.NewFS(root)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(root); err != nil {
		t.Fatal(err)
	}
	if _, err := s.SweepTemp(context.Background(), time.Hour); err == nil {
		t.Fatal("expected an error for a missing root")
	}
}

// Construction is cheap and side-effect free: commands like admin and
// migrate open the blob store without walking or changing it.
func TestNewFSDoesNotSweep(t *testing.T) {
	root := t.TempDir()
	_, stale, fresh := tempLayout(t, root)
	if _, err := blob.NewFS(root); err != nil {
		t.Fatal(err)
	}
	for _, p := range append([]string{fresh}, stale...) {
		if !exists(t, p) {
			t.Errorf("NewFS removed %s", p)
		}
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
