package blob

import (
	"context"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

// recordSyncs makes f record the directories it fsyncs instead of syncing them.
func recordSyncs(f *FS) *[]string {
	var mu sync.Mutex
	var synced []string
	f.syncDir = func(dir string) error {
		mu.Lock()
		defer mu.Unlock()
		synced = append(synced, dir)
		return nil
	}
	return &synced
}

// The first blob into a new directory makes the whole chain up to the root
// durable; later blobs into that directory only need their own directory.
func TestPutFsyncsOnlyTheDirectoriesItNeeds(t *testing.T) {
	root := t.TempDir()
	f, err := NewFS(root)
	if err != nil {
		t.Fatal(err)
	}
	synced := recordSyncs(f)
	ctx := context.Background()
	dir := filepath.Join(root, "vault", "ab")

	if err := f.Put(ctx, "vault/ab/one", strings.NewReader("x")); err != nil {
		t.Fatal(err)
	}
	want := []string{dir, filepath.Join(root, "vault"), filepath.Clean(root)}
	if strings.Join(*synced, ",") != strings.Join(want, ",") {
		t.Fatalf("first put synced %v, want %v", *synced, want)
	}

	*synced = nil
	if err := f.Put(ctx, "vault/ab/two", strings.NewReader("y")); err != nil {
		t.Fatal(err)
	}
	if strings.Join(*synced, ",") != dir {
		t.Fatalf("a put into a known directory synced %v, want only %s", *synced, dir)
	}

	*synced = nil
	if err := f.Put(ctx, "vault/cd/three", strings.NewReader("z")); err != nil {
		t.Fatal(err)
	}
	want = []string{filepath.Join(root, "vault", "cd"), filepath.Join(root, "vault"), filepath.Clean(root)}
	if strings.Join(*synced, ",") != strings.Join(want, ",") {
		t.Fatalf("a put into a new sibling directory synced %v, want %v", *synced, want)
	}
}
