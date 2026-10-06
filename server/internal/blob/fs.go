package blob

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// tempPrefix names in-flight Put files. Valid keys never start with '.', so
// no published blob can match it.
const tempPrefix = ".tmp-"

// FS stores blobs as files under a root directory. It is single-node only:
// it and SweepTemp assume one server owns root, so clustered deployments use
// object storage (blob_backend "s3") instead; config.Validate enforces this.
type FS struct{ root string }

// NewFS creates root if needed. It does not scan the tree; stale temp files
// are removed by SweepTemp, which the maintenance runner calls.
func NewFS(root string) (*FS, error) {
	if err := os.MkdirAll(root, 0o750); err != nil {
		return nil, fmt.Errorf("create blob dir: %w", err)
	}
	return &FS{root: root}, nil
}

// SweepTemp removes temp files last modified more than olderThan ago. They
// are left by Puts interrupted by a crash, which chunk GC never sees because
// they have no database row. olderThan must exceed how long a Put can go
// without writing, or a Put still running (possibly in another process) loses
// its file. Walking the tree is O(blobs), so this belongs in periodic
// maintenance rather than on every start.
//
// It stops with ctx's error when ctx ends. Otherwise only failure to read the
// root itself is an error; unreadable subtrees and failed removals are skipped.
func (f *FS) SweepTemp(ctx context.Context, olderThan time.Duration) (removed int, err error) {
	cutoff := time.Now().Add(-olderThan)
	err = filepath.WalkDir(f.root, func(p string, d fs.DirEntry, err error) error {
		if cerr := ctx.Err(); cerr != nil {
			return cerr
		}
		if err != nil {
			if p == f.root {
				return err
			}
			if d != nil && d.IsDir() {
				return fs.SkipDir
			}
			return nil
		}
		if !d.Type().IsRegular() || !strings.HasPrefix(d.Name(), tempPrefix) {
			return nil
		}
		if info, err := d.Info(); err == nil && info.ModTime().Before(cutoff) {
			//nolint:gosec // G122: the blob tree is private to the server process (data dir mode 0700)
			if os.Remove(p) == nil {
				removed++
			}
		}
		return nil
	})
	if err != nil {
		return removed, fmt.Errorf("sweep blob temp files: %w", err)
	}
	return removed, nil
}

func (f *FS) path(key string) (string, error) {
	if !ValidKey(key) {
		return "", fmt.Errorf("invalid blob key %q", key)
	}
	return filepath.Join(f.root, filepath.FromSlash(key)), nil
}

func (f *FS) Put(ctx context.Context, key string, r io.Reader) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	p, err := f.path(key)
	if err != nil {
		return err
	}
	dir := filepath.Dir(p)
	if err := os.MkdirAll(dir, 0o750); err != nil {
		return fmt.Errorf("create blob dir: %w", err)
	}
	tmp, err := os.CreateTemp(dir, tempPrefix+"*")
	if err != nil {
		return fmt.Errorf("create temp blob: %w", err)
	}
	cleanup := func() { tmp.Close(); os.Remove(tmp.Name()) }
	if _, err := io.Copy(tmp, r); err != nil {
		cleanup()
		return fmt.Errorf("write blob: %w", err)
	}
	if err := tmp.Sync(); err != nil {
		cleanup()
		return fmt.Errorf("sync blob: %w", err)
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmp.Name())
		return fmt.Errorf("close blob: %w", err)
	}
	if err := os.Rename(tmp.Name(), p); err != nil {
		os.Remove(tmp.Name())
		return fmt.Errorf("publish blob: %w", err)
	}
	// The caller records the blob in the database as soon as Put returns, so
	// the rename (and any directories MkdirAll created) must survive a crash.
	if err := f.syncDirs(dir); err != nil {
		return fmt.Errorf("sync blob dir: %w", err)
	}
	return nil
}

// syncDirs fsyncs dir and each parent up to and including the root.
func (f *FS) syncDirs(dir string) error {
	root := filepath.Clean(f.root)
	for d := filepath.Clean(dir); ; d = filepath.Dir(d) {
		if err := syncDir(d); err != nil {
			return err
		}
		if d == root || d == filepath.Dir(d) {
			return nil
		}
	}
}

func syncDir(dir string) error {
	d, err := os.Open(dir)
	if err != nil {
		return err
	}
	if err := d.Sync(); err != nil {
		d.Close()
		return err
	}
	return d.Close()
}

func (f *FS) Get(ctx context.Context, key string) (io.ReadCloser, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	p, err := f.path(key)
	if err != nil {
		return nil, err
	}
	file, err := os.Open(p)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("open blob: %w", err)
	}
	// A key that is a prefix of other keys names a directory, which opens
	// fine but fails on Read.
	info, err := file.Stat()
	if err != nil {
		file.Close()
		return nil, fmt.Errorf("stat blob: %w", err)
	}
	if !info.Mode().IsRegular() {
		file.Close()
		return nil, ErrNotFound
	}
	return file, nil
}

func (f *FS) Delete(ctx context.Context, key string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	p, err := f.path(key)
	if err != nil {
		return err
	}
	if err := os.Remove(p); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return fmt.Errorf("delete blob: %w", err)
	}
	return nil
}

func (f *FS) Ping(_ context.Context) error {
	info, err := os.Stat(f.root)
	if err != nil {
		return fmt.Errorf("blob dir: %w", err)
	}
	if !info.IsDir() {
		return fmt.Errorf("blob dir %s is not a directory", f.root)
	}
	return nil
}
